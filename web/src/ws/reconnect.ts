export interface BackoffOptions {
  initialMs?: number
  maximumMs?: number
  jitterRatio?: number
  random?: () => number
}

export class ExponentialBackoff {
  private readonly initialMs: number
  private readonly maximumMs: number
  private readonly jitterRatio: number
  private readonly random: () => number
  private currentMs: number

  constructor(options: BackoffOptions = {}) {
    this.initialMs = options.initialMs ?? 1_000
    this.maximumMs = options.maximumMs ?? 30_000
    this.jitterRatio = options.jitterRatio ?? 0.2
    this.random = options.random ?? Math.random
    this.currentMs = this.initialMs
  }

  nextDelay(): number {
    const factor = 1 - this.jitterRatio + this.random() * this.jitterRatio * 2
    const delay = Math.round(this.currentMs * factor)
    this.currentMs = Math.min(this.currentMs * 2, this.maximumMs)
    return delay
  }

  reset(): void {
    this.currentMs = this.initialMs
  }

  peekBaseDelay(): number {
    return this.currentMs
  }
}
