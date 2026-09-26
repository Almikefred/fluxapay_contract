use soroban_sdk::{contract, contractimpl, contracttype, symbol_short, Address, Env, String, Symbol, Vec};

/// Storage keys for the subscription contract.
#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Plan(Symbol),
    Subscription(Symbol, Address),
    MerchantPlans(Address),
    Admin,
}

/// A subscription plan offered by a merchant.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubscriptionPlan {
    pub plan_id: Symbol,
    pub merchant: Address,
    pub name: String,
    pub price: i128,
    pub interval: u64,
    pub active: bool,
    /// When true the plan is retired: no new subscriptions may be created,
    /// but existing subscribers continue to bill until they cancel.
    pub archived: bool,
}

/// A subscriber's active subscription to a plan.
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Subscription {
    pub plan_id: Symbol,
    pub subscriber: Address,
    pub started_at: u64,
    pub last_billed_at: u64,
    pub active: bool,
}

/// Errors returned by the subscription contract.
#[contracttype]
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SubscriptionError {
    PlanNotFound,
    PlanInactive,
    PlanArchived,
    SubscriptionNotFound,
    Unauthorized,
    AlreadySubscribed,
}

const PLAN_ARCHIVED: Symbol = symbol_short!("PLAN_ARCHIVED");
const PLAN_RESTORED: Symbol = symbol_short!("PLAN_RESTORED");

#[contract]
pub struct SubscriptionContract;

#[contractimpl]
impl SubscriptionContract {
    /// Create a new subscription plan owned by `merchant`.
    pub fn create_plan(
        env: Env,
        merchant: Address,
        plan_id: Symbol,
        name: String,
        price: i128,
        interval: u64,
    ) -> Result<(), SubscriptionError> {
        merchant.require_auth();

        let plan = SubscriptionPlan {
            plan_id: plan_id.clone(),
            merchant: merchant.clone(),
            name,
            price,
            interval,
            active: true,
            archived: false,
        };

        env.storage().persistent().set(&DataKey::Plan(plan_id.clone()), &plan);

        let mut plans: Vec<Symbol> = env
            .storage()
            .persistent()
            .get(&DataKey::MerchantPlans(merchant.clone()))
            .unwrap_or(Vec::new(&env));
        plans.push_back(plan_id);
        env.storage()
            .persistent()
            .set(&DataKey::MerchantPlans(merchant), &plans);

        Ok(())
    }

    /// Subscribe `subscriber` to an existing, non-archived plan.
    pub fn subscribe(
        env: Env,
        subscriber: Address,
        plan_id: Symbol,
    ) -> Result<(), SubscriptionError> {
        subscriber.require_auth();

        let plan: SubscriptionPlan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(plan_id.clone()))
            .ok_or(SubscriptionError::PlanNotFound)?;

        if plan.archived {
            return Err(SubscriptionError::PlanArchived);
        }
        if !plan.active {
            return Err(SubscriptionError::PlanInactive);
        }

        let key = DataKey::Subscription(plan_id.clone(), subscriber.clone());
        if env.storage().persistent().has(&key) {
            return Err(SubscriptionError::AlreadySubscribed);
        }

        let now = env.ledger().timestamp();
        let subscription = Subscription {
            plan_id,
            subscriber,
            started_at: now,
            last_billed_at: now,
            active: true,
        };
        env.storage().persistent().set(&key, &subscription);

        Ok(())
    }

    /// Retire a plan without deleting its history. Requires merchant auth.
    /// Existing subscribers continue to bill until they cancel.
    pub fn archive_plan(
        env: Env,
        merchant: Address,
        plan_id: Symbol,
    ) -> Result<(), SubscriptionError> {
        merchant.require_auth();

        let mut plan: SubscriptionPlan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(plan_id.clone()))
            .ok_or(SubscriptionError::PlanNotFound)?;

        if plan.merchant != merchant {
            return Err(SubscriptionError::Unauthorized);
        }

        plan.archived = true;
        env.storage().persistent().set(&DataKey::Plan(plan_id.clone()), &plan);

        env.events()
            .publish((symbol_short!("SUBSCRIPTION"), PLAN_ARCHIVED), plan_id);

        Ok(())
    }

    /// Reactivate an archived plan. Admin only.
    pub fn restore_plan(
        env: Env,
        admin: Address,
        plan_id: Symbol,
    ) -> Result<(), SubscriptionError> {
        admin.require_auth();

        let stored_admin: Address = env
            .storage()
            .persistent()
            .get(&DataKey::Admin)
            .ok_or(SubscriptionError::Unauthorized)?;
        if stored_admin != admin {
            return Err(SubscriptionError::Unauthorized);
        }

        let mut plan: SubscriptionPlan = env
            .storage()
            .persistent()
            .get(&DataKey::Plan(plan_id.clone()))
            .ok_or(SubscriptionError::PlanNotFound)?;

        plan.archived = false;
        env.storage().persistent().set(&DataKey::Plan(plan_id.clone()), &plan);

        env.events()
            .publish((symbol_short!("SUBSCRIPTION"), PLAN_RESTORED), plan_id);

        Ok(())
    }

    /// Bill an existing subscription. Archived plans still bill active subscribers.
    pub fn bill(
        env: Env,
        plan_id: Symbol,
        subscriber: Address,
    ) -> Result<(), SubscriptionError> {
        let key = DataKey::Subscription(plan_id.clone(), subscriber.clone());
        let mut subscription: Subscription = env
            .storage()
            .persistent()
            .get(&key)
            .ok_or(SubscriptionError::SubscriptionNotFound)?;

        if !subscription.active {
            return Err(SubscriptionError::SubscriptionNotFound);
        }

        // Note: archived plans intentionally continue to bill existing subscribers.
        subscription.last_billed_at = env.ledger().timestamp();
        env.storage().persistent().set(&key, &subscription);

        Ok(())
    }

    /// Fetch a plan by id.
    pub fn get_plan(env: Env, plan_id: Symbol) -> Result<SubscriptionPlan, SubscriptionError> {
        env.storage()
            .persistent()
            .get(&DataKey::Plan(plan_id))
            .ok_or(SubscriptionError::PlanNotFound)
    }
}
