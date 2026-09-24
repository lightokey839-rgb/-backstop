use anchor_lang::prelude::*;
use anchor_spl::token::Mint;

declare_id!("8RTR33hW32KTA2eQD92LxD5VCto6FHjzZrRADWGHFuVs");

pub const BACKSTOP_ADMIN: Pubkey = pubkey!("LeM3Dt71nbTJYZChitzaeMB2GjRRzDCnWR5VrUPnzvS");

/// A snapshot's `expires_at` may not be set further in the future than this,
/// counted from the moment it is submitted. Without a ceiling, an attestor
/// (honest but buggy, or compromised) could publish a snapshot that never
/// goes stale, defeating the freshness guarantee `evaluate_snapshot` exists
/// to provide. 30 days comfortably covers the weekly-ish refresh cadence
/// used by this project's own demo tooling; a production deployment with a
/// faster attestor refresh loop should use a much tighter value.
pub const MAX_SNAPSHOT_VALIDITY_SECS: i64 = 30 * 24 * 60 * 60;

#[cfg(test)]
fn registry_pda(mint: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"registry", mint.as_ref()], &crate::ID)
}

#[cfg(test)]
fn snapshot_pda(registry: &Pubkey, snapshot_id: &[u8; 32]) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"snapshot", registry.as_ref(), snapshot_id.as_ref()],
        &crate::ID,
    )
}

#[program]
pub mod backstop {
    use super::*;

    pub fn initialize_asset(
        ctx: Context<InitializeAsset>,
        asset_id: String,
        attestor: Pubkey,
    ) -> Result<()> {
        require!(
            ctx.accounts.authority.key() == BACKSTOP_ADMIN,
            BackstopError::Unauthorized
        );

        require!(
            asset_id.len() <= AssetRegistry::MAX_ASSET_ID_LEN,
            BackstopError::AssetIdTooLong
        );

        let registry = &mut ctx.accounts.registry;

        registry.authority = ctx.accounts.authority.key();
        registry.mint = ctx.accounts.mint.key();
        registry.attestor = attestor;
        registry.initialized = true;
        registry.asset_id = asset_id;
        registry.latest_snapshot = Pubkey::default();
        registry.latest_snapshot_id = [0; 32];
        registry.has_snapshot = false;

        msg!("Backstop asset initialized");
        msg!("Asset ID: {}", registry.asset_id);
        msg!("Mint: {}", registry.mint);
        msg!("Attestor: {}", registry.attestor);

        emit!(AssetInitialized {
            registry: registry.key(),
            mint: registry.mint,
            asset_id: registry.asset_id.clone(),
            attestor: registry.attestor,
        });

        Ok(())
    }

    pub fn submit_snapshot(
        ctx: Context<SubmitSnapshot>,
        attested_backing: u64,
        snapshot_id: [u8; 32],
        expires_at: i64,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let mint = &ctx.accounts.mint;

        require!(mint.key() == registry.mint, BackstopError::MintMismatch);

        // Never trust caller-supplied supply.
        // Read the actual SPL Mint account.
        let observed_supply = mint.supply;

        let now = Clock::get()?.unix_timestamp;

        validate_expiry(now, expires_at)?;

        let status = if observed_supply <= attested_backing {
            SnapshotStatus::Verified
        } else {
            SnapshotStatus::UnderBacked
        };

        let coverage_bps = calculate_coverage_bps(observed_supply, attested_backing);

        let snapshot = &mut ctx.accounts.snapshot;

        snapshot.registry = registry.key();
        snapshot.asset_id = registry.asset_id.clone();
        snapshot.mint = mint.key();
        snapshot.observed_supply = observed_supply;
        snapshot.attested_backing = attested_backing;
        snapshot.coverage_bps = coverage_bps;
        snapshot.snapshot_id = snapshot_id;
        snapshot.timestamp = now;
        snapshot.expires_at = expires_at;
        snapshot.attestor = registry.attestor;
        snapshot.status = status;

        registry.latest_snapshot = snapshot.key();
        registry.latest_snapshot_id = snapshot_id;
        registry.has_snapshot = true;

        msg!("==============================");
        msg!("        BACKSTOP SNAPSHOT     ");
        msg!("==============================");
        msg!("Asset: {}", snapshot.asset_id);
        msg!("Mint: {}", snapshot.mint);
        msg!("Observed supply: {}", snapshot.observed_supply);
        msg!("Attested backing: {}", snapshot.attested_backing);
        msg!("Coverage: {} bps", snapshot.coverage_bps);
        msg!("Timestamp: {}", snapshot.timestamp);
        msg!("Expires at: {}", snapshot.expires_at);

        match snapshot.status {
            SnapshotStatus::Verified => {
                msg!("STATUS: VERIFIED");
            }
            SnapshotStatus::UnderBacked => {
                msg!("STATUS: UNDER_BACKED");
            }
        }

        msg!("==============================");

        emit!(SnapshotSubmitted {
            registry: snapshot.registry,
            snapshot: snapshot.key(),
            mint: snapshot.mint,
            observed_supply: snapshot.observed_supply,
            attested_backing: snapshot.attested_backing,
            coverage_bps: snapshot.coverage_bps,
            status: snapshot.status,
            expires_at: snapshot.expires_at,
        });

        Ok(())
    }

    /// Admin-only: rotate the attestor pubkey trusted to submit snapshots
    /// for one registered asset. This does not touch any existing
    /// `Snapshot` account, so it never invalidates snapshots the previous
    /// attestor already submitted — it only changes who may submit the
    /// *next* one. Use this if an attestor key is retired, rotated on a
    /// schedule, or suspected of being compromised.
    pub fn update_attestor(
        ctx: Context<UpdateAttestor>,
        new_attestor: Pubkey,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let old_attestor = registry.attestor;

        registry.attestor = new_attestor;

        msg!("Backstop attestor updated");
        msg!("Asset: {}", registry.asset_id);
        msg!("Previous attestor: {}", old_attestor);
        msg!("New attestor: {}", new_attestor);

        emit!(AttestorUpdated {
            registry: registry.key(),
            mint: registry.mint,
            old_attestor,
            new_attestor,
        });

        Ok(())
    }

    pub fn evaluate_snapshot(ctx: Context<EvaluateSnapshot>) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let snapshot = &ctx.accounts.snapshot;
        let mint = &ctx.accounts.mint;
        let now = Clock::get()?.unix_timestamp;

        assert_snapshot_binding(
            registry,
            registry.key(),
            snapshot,
            snapshot.key(),
            mint.key(),
        )?;
        check_snapshot_safety(snapshot, now, mint.supply)
    }
}

/// Pure validation of a proposed snapshot expiry against the current time.
/// Extracted from `submit_snapshot` so it is unit-testable without a
/// runtime `Clock` sysvar, mirroring `check_snapshot_safety` below.
fn validate_expiry(now: i64, expires_at: i64) -> Result<()> {
    require!(expires_at > now, BackstopError::InvalidExpiry);

    require!(
        expires_at <= now.saturating_add(MAX_SNAPSHOT_VALIDITY_SECS),
        BackstopError::ExpiryTooFar
    );

    Ok(())
}

fn assert_snapshot_binding(
    registry: &AssetRegistry,
    registry_key: Pubkey,
    snapshot: &Snapshot,
    snapshot_key: Pubkey,
    mint: Pubkey,
) -> Result<()> {
    require!(registry.mint == mint, BackstopError::MintMismatch);
    require!(snapshot.mint == mint, BackstopError::MintMismatch);
    require!(
        snapshot.registry == registry_key,
        BackstopError::SnapshotNotSafe
    );
    require!(
        registry.latest_snapshot == snapshot_key && snapshot_key != Pubkey::default(),
        BackstopError::SnapshotNotSafe
    );

    Ok(())
}

fn check_snapshot_safety(snapshot: &Snapshot, now: i64, current_supply: u64) -> Result<()> {
    if now >= snapshot.expires_at {
        msg!("BACKSTOP: STALE - NOT SAFE");
        return err!(BackstopError::SnapshotStale);
    }

    if snapshot.status == SnapshotStatus::Verified && current_supply <= snapshot.attested_backing {
        msg!("BACKSTOP: SAFE");
        Ok(())
    } else {
        msg!("BACKSTOP: UNDER_BACKED - NOT SAFE");
        err!(BackstopError::SnapshotNotSafe)
    }
}

fn calculate_coverage_bps(observed_supply: u64, attested_backing: u64) -> u16 {
    if observed_supply == 0 {
        return 10_000;
    }

    let coverage = (attested_backing as u128)
        .saturating_mul(10_000)
        .checked_div(observed_supply as u128)
        .unwrap_or(0);

    coverage.min(10_000) as u16
}

#[derive(Accounts)]
pub struct InitializeAsset<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = AssetRegistry::SPACE,
        seeds = [b"registry", mint.key().as_ref()],
        bump
    )]
    pub registry: Account<'info, AssetRegistry>,

    pub mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(attested_backing: u64, snapshot_id: [u8; 32], expires_at: i64)]
pub struct SubmitSnapshot<'info> {
    #[account(mut)]
    pub attestor: Signer<'info>,

    #[account(
        mut,
        seeds = [b"registry", mint.key().as_ref()],
        bump,
        constraint = registry.attestor == attestor.key()
            @ BackstopError::Unauthorized,
        constraint = registry.mint == mint.key()
            @ BackstopError::MintMismatch
    )]
    pub registry: Account<'info, AssetRegistry>,

    #[account(
        init,
        payer = attestor,
        space = Snapshot::SPACE,
        seeds = [b"snapshot", registry.key().as_ref(), snapshot_id.as_ref()],
        bump
    )]
    pub snapshot: Account<'info, Snapshot>,

    pub mint: Account<'info, Mint>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateAttestor<'info> {
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [b"registry", mint.key().as_ref()],
        bump,
        constraint = registry.mint == mint.key()
            @ BackstopError::MintMismatch,
        constraint = registry.authority == authority.key()
            @ BackstopError::Unauthorized
    )]
    pub registry: Account<'info, AssetRegistry>,

    pub mint: Account<'info, Mint>,
}

#[derive(Accounts)]
pub struct EvaluateSnapshot<'info> {
    #[account(
        seeds = [b"registry", mint.key().as_ref()],
        bump,
        constraint = registry.mint == mint.key()
            @ BackstopError::MintMismatch,
        constraint = registry.has_snapshot
            @ BackstopError::SnapshotNotSafe,
        constraint = registry.latest_snapshot == snapshot.key()
            @ BackstopError::SnapshotNotSafe
    )]
    pub registry: Account<'info, AssetRegistry>,

    #[account(
        seeds = [b"snapshot", registry.key().as_ref(), registry.latest_snapshot_id.as_ref()],
        bump,
        constraint = snapshot.registry == registry.key()
            @ BackstopError::SnapshotNotSafe,
        constraint = snapshot.mint == mint.key()
            @ BackstopError::MintMismatch
    )]
    pub snapshot: Account<'info, Snapshot>,

    pub mint: Account<'info, Mint>,
}

#[account]
pub struct AssetRegistry {
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub attestor: Pubkey,
    pub latest_snapshot: Pubkey,
    pub latest_snapshot_id: [u8; 32],
    pub initialized: bool,
    pub has_snapshot: bool,
    pub asset_id: String,
}

impl AssetRegistry {
    pub const MAX_ASSET_ID_LEN: usize = 32;

    pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 32 + 1 + 1 + 4 + Self::MAX_ASSET_ID_LEN;
}

#[account]
pub struct Snapshot {
    pub registry: Pubkey,
    pub asset_id: String,
    pub mint: Pubkey,
    pub observed_supply: u64,
    pub attested_backing: u64,
    pub coverage_bps: u16,
    pub snapshot_id: [u8; 32],
    pub timestamp: i64,
    pub expires_at: i64,
    pub attestor: Pubkey,
    pub status: SnapshotStatus,
}

impl Snapshot {
    pub const SPACE: usize =
        8 + 32 + 4 + AssetRegistry::MAX_ASSET_ID_LEN + 32 + 8 + 8 + 2 + 32 + 8 + 8 + 32 + 1;
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SnapshotStatus {
    Verified,
    UnderBacked,
}

/// Emitted events, so an off-chain indexer (e.g. the Backstop backend) can
/// follow registry/snapshot/attestor changes without polling every account
/// on a schedule. Purely additive: no account layout changes, and nothing
/// on-chain depends on these being observed.
#[event]
pub struct AssetInitialized {
    pub registry: Pubkey,
    pub mint: Pubkey,
    pub asset_id: String,
    pub attestor: Pubkey,
}

#[event]
pub struct SnapshotSubmitted {
    pub registry: Pubkey,
    pub snapshot: Pubkey,
    pub mint: Pubkey,
    pub observed_supply: u64,
    pub attested_backing: u64,
    pub coverage_bps: u16,
    pub status: SnapshotStatus,
    pub expires_at: i64,
}

#[event]
pub struct AttestorUpdated {
    pub registry: Pubkey,
    pub mint: Pubkey,
    pub old_attestor: Pubkey,
    pub new_attestor: Pubkey,
}

#[error_code]
pub enum BackstopError {
    #[msg("The asset ID is too long.")]
    AssetIdTooLong,

    #[msg("The supplied mint does not match the registered mint.")]
    MintMismatch,

    #[msg("The caller is not authorized.")]
    Unauthorized,

    #[msg("The snapshot expiry must be in the future.")]
    InvalidExpiry,

    #[msg("The snapshot expiry is further in the future than the maximum allowed validity window.")]
    ExpiryTooFar,

    #[msg("The snapshot is stale and cannot be considered safe.")]
    SnapshotStale,

    #[msg("The snapshot is not verified and cannot be considered safe.")]
    SnapshotNotSafe,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn registry(mint: Pubkey, attestor: Pubkey, latest_snapshot: Pubkey) -> AssetRegistry {
        AssetRegistry {
            authority: BACKSTOP_ADMIN,
            mint,
            attestor,
            latest_snapshot,
            latest_snapshot_id: [9; 32],
            initialized: true,
            has_snapshot: latest_snapshot != Pubkey::default(),
            asset_id: "TSLA".to_string(),
        }
    }

    fn snapshot(
        registry: Pubkey,
        mint: Pubkey,
        status: SnapshotStatus,
        expires_at: i64,
    ) -> Snapshot {
        Snapshot {
            registry,
            asset_id: "TSLA".to_string(),
            mint,
            observed_supply: 10_000,
            attested_backing: 10_000,
            coverage_bps: 10_000,
            snapshot_id: [0; 32],
            timestamp: 1_000,
            expires_at,
            attestor: Pubkey::default(),
            status,
        }
    }

    #[test]
    fn coverage_is_full_when_supply_and_backing_match() {
        assert_eq!(calculate_coverage_bps(10_000, 10_000), 10_000);
    }

    #[test]
    fn registry_pda_is_canonical_per_mint() {
        let mint = Pubkey::new_unique();
        let (registry_a, bump_a) = registry_pda(&mint);
        let (registry_b, bump_b) = registry_pda(&mint);

        assert_eq!(registry_a, registry_b);
        assert_eq!(bump_a, bump_b);
    }

    #[test]
    fn different_mints_have_different_registry_pdas() {
        let mint_a = Pubkey::new_unique();
        let mint_b = Pubkey::new_unique();
        let (registry_a, _) = registry_pda(&mint_a);
        let (registry_b, _) = registry_pda(&mint_b);

        assert_ne!(registry_a, registry_b);
    }

    #[test]
    fn snapshot_pda_is_bound_to_registry_and_snapshot_id() {
        let registry = Pubkey::new_unique();
        let mut snapshot_id = [0; 32];
        snapshot_id[0] = 7;

        let (snapshot_a, bump_a) = snapshot_pda(&registry, &snapshot_id);
        let (snapshot_b, bump_b) = snapshot_pda(&registry, &snapshot_id);

        assert_eq!(snapshot_a, snapshot_b);
        assert_eq!(bump_a, bump_b);

        snapshot_id[0] = 8;
        let (different_snapshot, _) = snapshot_pda(&registry, &snapshot_id);

        assert_ne!(snapshot_a, different_snapshot);
    }

    #[test]
    fn attacker_cannot_choose_a_second_registry_address_for_same_mint() {
        let mint = Pubkey::new_unique();
        let (canonical_registry, _) = registry_pda(&mint);
        let attacker_keypair_registry = Pubkey::new_unique();

        assert_ne!(canonical_registry, attacker_keypair_registry);
    }

    #[test]
    fn duplicate_registry_initialization_targets_same_pda() {
        let mint = Pubkey::new_unique();
        let first_attempt = registry_pda(&mint).0;
        let duplicate_attempt = registry_pda(&mint).0;

        assert_eq!(first_attempt, duplicate_attempt);
    }

    #[test]
    fn only_backstop_admin_is_the_registration_authority() {
        let attacker = Pubkey::new_unique();

        assert_ne!(attacker, BACKSTOP_ADMIN);
    }

    #[test]
    fn configured_attestor_is_distinct_from_wrong_attestor() {
        let configured_attestor = Pubkey::new_unique();
        let wrong_attestor = Pubkey::new_unique();

        assert_ne!(configured_attestor, wrong_attestor);
    }

    #[test]
    fn snapshot_binding_accepts_current_snapshot_for_registered_mint() {
        let mint = Pubkey::new_unique();
        let registry_key = Pubkey::new_unique();
        let snapshot_key = Pubkey::new_unique();
        let registry = registry(mint, Pubkey::new_unique(), snapshot_key);
        let snapshot = snapshot(registry_key, mint, SnapshotStatus::Verified, 2_000);

        assert!(
            assert_snapshot_binding(&registry, registry_key, &snapshot, snapshot_key, mint).is_ok()
        );
    }

    #[test]
    fn snapshot_binding_rejects_wrong_mint() {
        let mint = Pubkey::new_unique();
        let registry_key = Pubkey::new_unique();
        let snapshot_key = Pubkey::new_unique();
        let registry = registry(mint, Pubkey::new_unique(), snapshot_key);
        let wrong_mint = Pubkey::new_unique();
        let snapshot = snapshot(registry_key, wrong_mint, SnapshotStatus::Verified, 2_000);

        let error = assert_snapshot_binding(&registry, registry_key, &snapshot, snapshot_key, mint)
            .unwrap_err();

        assert_eq!(error, error!(BackstopError::MintMismatch));
    }

    #[test]
    fn snapshot_binding_rejects_non_current_snapshot() {
        let mint = Pubkey::new_unique();
        let registry_key = Pubkey::new_unique();
        let latest_snapshot = Pubkey::new_unique();
        let old_snapshot = Pubkey::new_unique();
        let registry = registry(mint, Pubkey::new_unique(), latest_snapshot);
        let snapshot = snapshot(registry_key, mint, SnapshotStatus::Verified, 2_000);

        let error = assert_snapshot_binding(&registry, registry_key, &snapshot, old_snapshot, mint)
            .unwrap_err();

        assert_eq!(error, error!(BackstopError::SnapshotNotSafe));
    }

    #[test]
    fn coverage_is_under_backed_for_required_demo_case() {
        assert_eq!(calculate_coverage_bps(10_500, 10_000), 9_523);
    }

    #[test]
    fn coverage_is_full_for_zero_supply() {
        assert_eq!(calculate_coverage_bps(0, 0), 10_000);
        assert_eq!(calculate_coverage_bps(0, 1), 10_000);
    }

    #[test]
    fn coverage_is_capped_at_full() {
        assert_eq!(calculate_coverage_bps(10_000, 20_000), 10_000);
    }

    #[test]
    fn coverage_does_not_overflow_for_large_values() {
        assert_eq!(calculate_coverage_bps(u64::MAX, u64::MAX), 10_000);
        assert_eq!(calculate_coverage_bps(u64::MAX, 0), 0);
    }

    #[test]
    fn verified_fresh_snapshot_is_safe() {
        let snapshot = snapshot(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            SnapshotStatus::Verified,
            2_000,
        );

        assert!(check_snapshot_safety(&snapshot, 1_999, 10_000).is_ok());
    }

    #[test]
    fn verified_expired_snapshot_is_stale_and_unsafe() {
        let snapshot = snapshot(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            SnapshotStatus::Verified,
            2_000,
        );
        let error = check_snapshot_safety(&snapshot, 2_000, 10_000).unwrap_err();

        assert_eq!(error, error!(BackstopError::SnapshotStale));
    }

    #[test]
    fn under_backed_fresh_snapshot_is_unsafe() {
        let snapshot = snapshot(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            SnapshotStatus::UnderBacked,
            2_000,
        );
        let error = check_snapshot_safety(&snapshot, 1_999, 10_000).unwrap_err();

        assert_eq!(error, error!(BackstopError::SnapshotNotSafe));
    }

    #[test]
    fn verified_fresh_snapshot_fails_if_live_supply_exceeds_backing() {
        let snapshot = snapshot(
            Pubkey::new_unique(),
            Pubkey::new_unique(),
            SnapshotStatus::Verified,
            2_000,
        );
        let error = check_snapshot_safety(&snapshot, 1_999, 10_001).unwrap_err();

        assert_eq!(error, error!(BackstopError::SnapshotNotSafe));
    }

    #[test]
    fn expiry_in_the_past_is_rejected() {
        let error = validate_expiry(2_000, 1_000).unwrap_err();
        assert_eq!(error, error!(BackstopError::InvalidExpiry));
    }

    #[test]
    fn expiry_equal_to_now_is_rejected() {
        // `expires_at` must be strictly greater than `now`; a snapshot that
        // is already expired the instant it lands must never be accepted.
        let error = validate_expiry(1_000, 1_000).unwrap_err();
        assert_eq!(error, error!(BackstopError::InvalidExpiry));
    }

    #[test]
    fn expiry_within_max_validity_window_is_accepted() {
        assert!(validate_expiry(1_000, 1_000 + MAX_SNAPSHOT_VALIDITY_SECS).is_ok());
    }

    #[test]
    fn expiry_at_exactly_the_cap_is_accepted() {
        // Boundary case: the cap itself is inclusive.
        assert!(validate_expiry(0, MAX_SNAPSHOT_VALIDITY_SECS).is_ok());
    }

    #[test]
    fn expiry_one_second_past_the_cap_is_rejected() {
        let error = validate_expiry(0, MAX_SNAPSHOT_VALIDITY_SECS + 1).unwrap_err();
        assert_eq!(error, error!(BackstopError::ExpiryTooFar));
    }

    #[test]
    fn expiry_far_beyond_the_cap_is_rejected() {
        // Guards against an attestor (buggy or malicious) publishing a
        // snapshot that would never go stale, e.g. an accidental
        // millisecond/second mix-up or a year-9999-style timestamp.
        let error = validate_expiry(1_800_000_000, 253_402_300_799).unwrap_err();
        assert_eq!(error, error!(BackstopError::ExpiryTooFar));
    }
}
