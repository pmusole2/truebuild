export class BudgetError extends Error {
    constructor() {
        super('budget_exhausted')
    }
}

/** Process-local attempt cap. Failures, cancellation and unknown outcomes never refund a call. */
export class ModelCallCounter {
    #used = 0

    constructor(readonly limit = 200) {
        if (!Number.isSafeInteger(limit) || limit <= 0) {
            throw new Error('invalid_model_call_limit')
        }
    }

    get used(): number {
        return this.#used
    }

    claim(): void {
        if (this.#used >= this.limit) {
            throw new BudgetError()
        }
        this.#used += 1
    }
}
