import { Merchant } from '../database/entities/merchant.entity';

declare global {
  namespace Express {
    interface Request {
      merchant?: Merchant;
    }
  }
}

export {};
