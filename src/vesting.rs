use soroban_sdk::{contract, contracterror, contractimpl, contracttype, token, Address, Env};

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VestingSchedule {
    pub beneficiary: Address,
    pub token: Address,
    pub total_amount: i128,
    pub released_amount: i128,
    pub start_time: u64,
    pub cliff_time: u64,
    pub end_time: u64,
}

#[contracterror]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum VestingError {
    AlreadyInitialized = 1,
    InvalidAmount = 2,
    InvalidDates = 3,
    NotInitialized = 4,
    NotBeneficiary = 5,
    NothingReleasable = 6,
}

#[contracttype]
enum DataKey {
    Schedule,
}

#[contract]
pub struct TeamVesting;

#[contractimpl]
impl TeamVesting {
    pub fn initialize(
        env: Env,
        beneficiary: Address,
        token: Address,
        total_amount: i128,
        start_time: u64,
        cliff_time: u64,
        end_time: u64,
    ) -> Result<(), VestingError> {
        if env.storage().instance().has(&DataKey::Schedule) {
            return Err(VestingError::AlreadyInitialized);
        }
        if total_amount <= 0 {
            return Err(VestingError::InvalidAmount);
        }
        if !(start_time <= cliff_time && cliff_time <= end_time && start_time < end_time) {
            return Err(VestingError::InvalidDates);
        }
        beneficiary.require_auth();
        env.storage().instance().set(
            &DataKey::Schedule,
            &VestingSchedule {
                beneficiary,
                token,
                total_amount,
                released_amount: 0,
                start_time,
                cliff_time,
                end_time,
            },
        );
        Ok(())
    }

    pub fn get_schedule(env: Env) -> Result<VestingSchedule, VestingError> {
        env.storage()
            .instance()
            .get(&DataKey::Schedule)
            .ok_or(VestingError::NotInitialized)
    }

    pub fn vested_amount(env: Env, at_time: u64) -> Result<i128, VestingError> {
        let schedule: VestingSchedule = Self::get_schedule(env)?;
        if at_time < schedule.cliff_time {
            return Ok(0);
        }
        if at_time >= schedule.end_time {
            return Ok(schedule.total_amount);
        }
        let elapsed = at_time.saturating_sub(schedule.cliff_time) as i128;
        let duration = schedule.end_time.saturating_sub(schedule.cliff_time) as i128;
        Ok(schedule.total_amount.saturating_mul(elapsed) / duration)
    }

    pub fn releasable_amount(env: Env) -> Result<i128, VestingError> {
        let schedule = Self::get_schedule(env.clone())?;
        Ok(Self::vested_amount(env, env.ledger().timestamp())?
            .saturating_sub(schedule.released_amount))
    }

    pub fn release(env: Env) -> Result<i128, VestingError> {
        let mut schedule = Self::get_schedule(env.clone())?;
        schedule.beneficiary.require_auth();
        let amount = Self::releasable_amount(env.clone())?;
        if amount <= 0 {
            return Err(VestingError::NothingReleasable);
        }
        schedule.released_amount = schedule.released_amount.saturating_add(amount);
        token::Client::new(&env, &schedule.token).transfer(
            &env.current_contract_address(),
            &schedule.beneficiary,
            &amount,
        );
        env.storage().instance().set(&DataKey::Schedule, &schedule);
        Ok(amount)
    }
}
