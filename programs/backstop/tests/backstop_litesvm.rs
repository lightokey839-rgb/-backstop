use anchor_lang::{
    prelude::Pubkey,
    solana_program::{
        clock::Clock, instruction::Instruction, program_pack::Pack, system_instruction,
        system_program,
    },
    AccountDeserialize, InstructionData, ToAccountMetas,
};
use anchor_spl::token::spl_token;
use litesvm::LiteSVM;
use programs_backstop::{
    accounts, instruction, AssetRegistry, BackstopError, Snapshot, SnapshotStatus, BACKSTOP_ADMIN,
    ID, MAX_SNAPSHOT_VALIDITY_SECS,
};
use solana_keypair::Keypair;
use solana_message::Message;
use solana_signer::Signer;
use solana_transaction::Transaction;

const TEST_NOW: i64 = 1_800_000_000;

struct TestEnv {
    svm: LiteSVM,
    payer: Keypair,
    mint: Pubkey,
    mint_authority: Keypair,
    token_account: Keypair,
    attestor: Keypair,
    wrong_attestor: Keypair,
    random_user: Keypair,
    registry: Pubkey,
}

fn program_so_path() -> String {
    format!(
        "{}/../../target/sbpf-solana-solana/release/programs_backstop.so",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn registry_pda(mint: &Pubkey) -> Pubkey {
    Pubkey::find_program_address(&[b"registry", mint.as_ref()], &ID).0
}

fn snapshot_pda(registry: &Pubkey, snapshot_id: &[u8; 32]) -> Pubkey {
    Pubkey::find_program_address(&[b"snapshot", registry.as_ref(), snapshot_id.as_ref()], &ID).0
}

fn set_clock(svm: &mut LiteSVM, unix_timestamp: i64) {
    let mut clock = svm.get_sysvar::<Clock>();
    clock.unix_timestamp = unix_timestamp;
    svm.set_sysvar(&clock);
}

fn tx(
    payer: Pubkey,
    instructions: &[Instruction],
    signers: &[&Keypair],
    svm: &LiteSVM,
) -> Transaction {
    Transaction::new(
        signers,
        Message::new(instructions, Some(&payer)),
        svm.latest_blockhash(),
    )
}

fn send_unsigned(svm: &mut LiteSVM, payer: Pubkey, instructions: &[Instruction]) -> bool {
    svm.send_transaction(Transaction::new_with_payer(instructions, Some(&payer)))
        .is_ok()
}

fn create_mint(svm: &mut LiteSVM, payer: &Keypair, mint: &Keypair, mint_authority: Pubkey) {
    let mint_rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Mint::LEN);
    let create_mint = system_instruction::create_account(
        &payer.pubkey(),
        &mint.pubkey(),
        mint_rent,
        spl_token::state::Mint::LEN as u64,
        &spl_token::ID,
    );
    let init_mint = spl_token::instruction::initialize_mint(
        &spl_token::ID,
        &mint.pubkey(),
        &mint_authority,
        None,
        0,
    )
    .unwrap();

    svm.send_transaction(tx(
        payer.pubkey(),
        &[create_mint, init_mint],
        &[payer, mint],
        svm,
    ))
    .unwrap();
}

fn create_token_account(
    svm: &mut LiteSVM,
    payer: &Keypair,
    token_account: &Keypair,
    mint: Pubkey,
    owner: Pubkey,
) {
    let account_rent = svm.minimum_balance_for_rent_exemption(spl_token::state::Account::LEN);
    let create_account = system_instruction::create_account(
        &payer.pubkey(),
        &token_account.pubkey(),
        account_rent,
        spl_token::state::Account::LEN as u64,
        &spl_token::ID,
    );
    let init_account = spl_token::instruction::initialize_account(
        &spl_token::ID,
        &token_account.pubkey(),
        &mint,
        &owner,
    )
    .unwrap();

    svm.send_transaction(tx(
        payer.pubkey(),
        &[create_account, init_account],
        &[payer, token_account],
        svm,
    ))
    .unwrap();
}

fn mint_to(
    svm: &mut LiteSVM,
    payer: &Keypair,
    mint: Pubkey,
    token_account: Pubkey,
    mint_authority: &Keypair,
    amount: u64,
) {
    let ix = spl_token::instruction::mint_to(
        &spl_token::ID,
        &mint,
        &token_account,
        &mint_authority.pubkey(),
        &[],
        amount,
    )
    .unwrap();

    svm.send_transaction(tx(payer.pubkey(), &[ix], &[payer, mint_authority], svm))
        .unwrap();
}

fn setup_env(initial_supply: u64) -> TestEnv {
    let mut svm = LiteSVM::new()
        .with_sigverify(false)
        .with_blockhash_check(false)
        .with_transaction_history(0)
        .with_default_programs();

    svm.add_program_from_file(ID, program_so_path())
        .expect("build the SBF program first with `anchor build --ignore-keys --no-idl -- --no-rustup-override --skip-tools-install`");

    let payer = Keypair::new();
    let mint_keypair = Keypair::new();
    let mint = mint_keypair.pubkey();
    let mint_authority = Keypair::new();
    let token_account = Keypair::new();
    let attestor = Keypair::new();
    let wrong_attestor = Keypair::new();
    let random_user = Keypair::new();

    for address in [
        payer.pubkey(),
        BACKSTOP_ADMIN,
        attestor.pubkey(),
        wrong_attestor.pubkey(),
        random_user.pubkey(),
    ] {
        svm.airdrop(&address, 10_000_000_000).unwrap();
    }

    set_clock(&mut svm, TEST_NOW);
    create_mint(&mut svm, &payer, &mint_keypair, mint_authority.pubkey());
    create_token_account(&mut svm, &payer, &token_account, mint, payer.pubkey());

    let registry = registry_pda(&mint);
    let mut env = TestEnv {
        svm,
        payer,
        mint,
        mint_authority,
        token_account,
        attestor,
        wrong_attestor,
        random_user,
        registry,
    };

    if initial_supply > 0 {
        mint_to(
            &mut env.svm,
            &env.payer,
            env.mint,
            env.token_account.pubkey(),
            &env.mint_authority,
            initial_supply,
        );
    }

    env
}

fn initialize_asset_ix(
    env: &TestEnv,
    authority: Pubkey,
    registry: Pubkey,
    mint: Pubkey,
) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts::InitializeAsset {
            authority,
            registry,
            mint,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::InitializeAsset {
            asset_id: "TSLA".to_string(),
            attestor: env.attestor.pubkey(),
        }
        .data(),
    }
}

fn submit_snapshot_ix(
    attestor: Pubkey,
    registry: Pubkey,
    snapshot_id: [u8; 32],
    mint: Pubkey,
    backing: u64,
    expires_at: i64,
) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts::SubmitSnapshot {
            attestor,
            registry,
            snapshot: snapshot_pda(&registry, &snapshot_id),
            mint,
            system_program: system_program::ID,
        }
        .to_account_metas(None),
        data: instruction::SubmitSnapshot {
            attested_backing: backing,
            snapshot_id,
            expires_at,
        }
        .data(),
    }
}

fn evaluate_snapshot_ix(registry: Pubkey, snapshot: Pubkey, mint: Pubkey) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts::EvaluateSnapshot {
            registry,
            snapshot,
            mint,
        }
        .to_account_metas(None),
        data: instruction::EvaluateSnapshot {}.data(),
    }
}

fn update_attestor_ix(
    authority: Pubkey,
    registry: Pubkey,
    mint: Pubkey,
    new_attestor: Pubkey,
) -> Instruction {
    Instruction {
        program_id: ID,
        accounts: accounts::UpdateAttestor {
            authority,
            registry,
            mint,
        }
        .to_account_metas(None),
        data: instruction::UpdateAttestor { new_attestor }.data(),
    }
}

fn register(env: &mut TestEnv) {
    let ix = initialize_asset_ix(env, BACKSTOP_ADMIN, env.registry, env.mint);
    assert!(send_unsigned(&mut env.svm, BACKSTOP_ADMIN, &[ix]));
}

fn submit(env: &mut TestEnv, snapshot_id: [u8; 32], backing: u64, expires_at: i64) -> Pubkey {
    let snapshot = snapshot_pda(&env.registry, &snapshot_id);
    let ix = submit_snapshot_ix(
        env.attestor.pubkey(),
        env.registry,
        snapshot_id,
        env.mint,
        backing,
        expires_at,
    );
    assert!(send_unsigned(&mut env.svm, env.attestor.pubkey(), &[ix]));
    snapshot
}

fn read_registry(env: &TestEnv) -> AssetRegistry {
    let account = env.svm.get_account(&env.registry).unwrap();
    AssetRegistry::try_deserialize(&mut account.data.as_slice()).unwrap()
}

fn read_snapshot(env: &TestEnv, snapshot: Pubkey) -> Snapshot {
    let account = env.svm.get_account(&snapshot).unwrap();
    Snapshot::try_deserialize(&mut account.data.as_slice()).unwrap()
}

#[test]
fn admin_can_register() {
    let mut env = setup_env(10_000);

    register(&mut env);

    let registry = read_registry(&env);
    assert_eq!(env.registry, registry_pda(&env.mint));
    assert_eq!(registry.mint, env.mint);
    assert_eq!(registry.authority, BACKSTOP_ADMIN);
    assert_eq!(registry.attestor, env.attestor.pubkey());
}

#[test]
fn random_user_cannot_register() {
    let mut env = setup_env(10_000);
    let ix = initialize_asset_ix(&env, env.random_user.pubkey(), env.registry, env.mint);

    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.random_user.pubkey())
        ))
        .is_err());
    assert!(env.svm.get_account(&env.registry).is_none());
}

#[test]
fn duplicate_registry_cannot_exist() {
    let mut env = setup_env(10_000);
    register(&mut env);

    let ix = initialize_asset_ix(&env, BACKSTOP_ADMIN, env.registry, env.mint);
    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(&[ix], Some(&BACKSTOP_ADMIN)))
        .is_err());
}

#[test]
fn approved_attestor_can_submit() {
    let mut env = setup_env(10_000);
    register(&mut env);

    let snapshot_id = [1; 32];
    let snapshot_key = submit(&mut env, snapshot_id, 10_000, TEST_NOW + 600);

    let registry = read_registry(&env);
    let snapshot = read_snapshot(&env, snapshot_key);
    assert_eq!(snapshot_key, snapshot_pda(&env.registry, &snapshot_id));
    assert_eq!(snapshot.observed_supply, 10_000);
    assert!(snapshot.status == SnapshotStatus::Verified);
    assert_eq!(registry.latest_snapshot, snapshot_key);
}

#[test]
fn wrong_attestor_cannot_submit() {
    let mut env = setup_env(10_000);
    register(&mut env);
    let snapshot_id = [2; 32];
    let ix = submit_snapshot_ix(
        env.wrong_attestor.pubkey(),
        env.registry,
        snapshot_id,
        env.mint,
        10_000,
        TEST_NOW + 600,
    );

    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.wrong_attestor.pubkey())
        ))
        .is_err());
}

#[test]
fn wrong_mint_cannot_be_used() {
    let mut env = setup_env(10_000);
    register(&mut env);
    let wrong_mint = Keypair::new().pubkey();
    let ix = submit_snapshot_ix(
        env.attestor.pubkey(),
        env.registry,
        [3; 32],
        wrong_mint,
        10_000,
        TEST_NOW + 600,
    );

    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.attestor.pubkey())
        ))
        .is_err());

    let snapshot = submit(&mut env, [10; 32], 10_000, TEST_NOW + 600);
    let wrong_mint_keypair = Keypair::new();
    create_mint(
        &mut env.svm,
        &env.payer,
        &wrong_mint_keypair,
        env.mint_authority.pubkey(),
    );
    let evaluate_with_wrong_mint = evaluate_snapshot_ix(
        registry_pda(&wrong_mint_keypair.pubkey()),
        snapshot,
        wrong_mint_keypair.pubkey(),
    );
    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[evaluate_with_wrong_mint],
            Some(&env.attestor.pubkey())
        ))
        .is_err());
}

#[test]
fn verified_fresh_covered_snapshot_is_safe() {
    let mut env = setup_env(10_000);
    register(&mut env);
    let snapshot = submit(&mut env, [4; 32], 10_000, TEST_NOW + 600);

    let ix = evaluate_snapshot_ix(env.registry, snapshot, env.mint);
    assert!(send_unsigned(&mut env.svm, env.attestor.pubkey(), &[ix]));
}

#[test]
fn under_backed_snapshot_is_unsafe() {
    let mut env = setup_env(10_500);
    register(&mut env);
    let snapshot = submit(&mut env, [5; 32], 10_000, TEST_NOW + 600);

    let ix = evaluate_snapshot_ix(env.registry, snapshot, env.mint);
    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.attestor.pubkey())
        ))
        .is_err());
}

#[test]
fn expired_snapshot_is_unsafe() {
    let mut env = setup_env(10_000);
    register(&mut env);
    let snapshot = submit(&mut env, [6; 32], 10_000, TEST_NOW + 600);
    set_clock(&mut env.svm, TEST_NOW + 600);

    let ix = evaluate_snapshot_ix(env.registry, snapshot, env.mint);
    let err = env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.attestor.pubkey()),
        ))
        .unwrap_err();
    assert!(format!("{err:?}").contains(&(BackstopError::SnapshotStale as u32).to_string()));
}

#[test]
fn live_supply_increase_is_detected() {
    let mut env = setup_env(10_000);
    register(&mut env);
    let snapshot = submit(&mut env, [7; 32], 10_000, TEST_NOW + 600);

    let safe_ix = evaluate_snapshot_ix(env.registry, snapshot, env.mint);
    assert!(send_unsigned(
        &mut env.svm,
        env.attestor.pubkey(),
        &[safe_ix]
    ));

    mint_to(
        &mut env.svm,
        &env.payer,
        env.mint,
        env.token_account.pubkey(),
        &env.mint_authority,
        500,
    );

    let unsafe_ix = evaluate_snapshot_ix(env.registry, snapshot, env.mint);
    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[unsafe_ix],
            Some(&env.attestor.pubkey())
        ))
        .is_err());
}

#[test]
fn snapshot_binding_rejects_non_current_snapshot() {
    let mut env = setup_env(10_000);
    register(&mut env);
    let old_snapshot = submit(&mut env, [8; 32], 10_000, TEST_NOW + 600);
    let _new_snapshot = submit(&mut env, [9; 32], 10_000, TEST_NOW + 600);

    let ix = evaluate_snapshot_ix(env.registry, old_snapshot, env.mint);
    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.attestor.pubkey())
        ))
        .is_err());
}

#[test]
fn fake_registry_attack_path_cannot_create_authoritative_registry() {
    let mut env = setup_env(10_000);
    let malicious_registry = Keypair::new().pubkey();
    let ix = initialize_asset_ix(&env, env.random_user.pubkey(), malicious_registry, env.mint);

    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.random_user.pubkey())
        ))
        .is_err());
    assert!(env.svm.get_account(&malicious_registry).is_none());
    assert!(env.svm.get_account(&env.registry).is_none());
}

#[test]
fn authority_can_rotate_attestor_and_old_attestor_loses_access() {
    let mut env = setup_env(10_000);
    register(&mut env);

    let new_attestor = Keypair::new();
    env.svm.airdrop(&new_attestor.pubkey(), 10_000_000_000).unwrap();

    let rotate_ix = update_attestor_ix(
        BACKSTOP_ADMIN,
        env.registry,
        env.mint,
        new_attestor.pubkey(),
    );
    assert!(send_unsigned(&mut env.svm, BACKSTOP_ADMIN, &[rotate_ix]));

    let registry = read_registry(&env);
    assert_eq!(registry.attestor, new_attestor.pubkey());

    // The old attestor keypair is no longer authorized to submit.
    let old_attestor_ix = submit_snapshot_ix(
        env.attestor.pubkey(),
        env.registry,
        [20; 32],
        env.mint,
        10_000,
        TEST_NOW + 600,
    );
    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[old_attestor_ix],
            Some(&env.attestor.pubkey())
        ))
        .is_err());

    // The newly-rotated attestor can submit immediately, no re-registration needed.
    let new_snapshot = snapshot_pda(&env.registry, &[21; 32]);
    let new_attestor_ix = submit_snapshot_ix(
        new_attestor.pubkey(),
        env.registry,
        [21; 32],
        env.mint,
        10_000,
        TEST_NOW + 600,
    );
    assert!(send_unsigned(
        &mut env.svm,
        new_attestor.pubkey(),
        &[new_attestor_ix]
    ));
    assert!(env.svm.get_account(&new_snapshot).is_some());
}

#[test]
fn non_authority_cannot_update_attestor() {
    let mut env = setup_env(10_000);
    register(&mut env);

    let attacker_attestor = Keypair::new();
    let ix = update_attestor_ix(
        env.random_user.pubkey(),
        env.registry,
        env.mint,
        attacker_attestor.pubkey(),
    );

    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.random_user.pubkey())
        ))
        .is_err());

    // The registered attestor is unchanged.
    let registry = read_registry(&env);
    assert_eq!(registry.attestor, env.attestor.pubkey());
}

#[test]
fn snapshot_expiry_beyond_max_validity_window_is_rejected() {
    let mut env = setup_env(10_000);
    register(&mut env);

    let ix = submit_snapshot_ix(
        env.attestor.pubkey(),
        env.registry,
        [22; 32],
        env.mint,
        10_000,
        TEST_NOW + MAX_SNAPSHOT_VALIDITY_SECS + 1,
    );

    assert!(env
        .svm
        .send_transaction(Transaction::new_with_payer(
            &[ix],
            Some(&env.attestor.pubkey())
        ))
        .is_err());
}

#[test]
fn snapshot_expiry_at_max_validity_boundary_is_accepted() {
    let mut env = setup_env(10_000);
    register(&mut env);

    let snapshot = submit(
        &mut env,
        [23; 32],
        10_000,
        TEST_NOW + MAX_SNAPSHOT_VALIDITY_SECS,
    );

    assert!(env.svm.get_account(&snapshot).is_some());
}
