export enum PaymentIntentStatus {
  Pending = 'pending',
  Processing = 'processing',
  Succeeded = 'succeeded',
  Failed = 'failed',
  Cancelled = 'cancelled',
}

export enum IdempotencyKeyStatus {
  Processing = 'processing',
  Completed = 'completed',
}

export enum AccountType {
  Escrow = 'escrow',
  Revenue = 'revenue',
  MerchantPayable = 'merchant_payable',
  External = 'external',
}

export enum LedgerEntryType {
  Debit = 'debit',
  Credit = 'credit',
}

export enum PayoutStatus {
  Pending = 'pending',
  Paid = 'paid',
  Cancelled = 'cancelled',
}

export enum RefundStatus {
  Pending = 'pending',
  Succeeded = 'succeeded',
  Failed = 'failed',
}

export enum WebhookEventStatus {
  Pending = 'pending',
  Delivered = 'delivered',
  Failed = 'failed',
}
