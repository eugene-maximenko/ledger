import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { InjectRepository } from '@nestjs/typeorm';
import { Request } from 'express';
import { Repository } from 'typeorm';
import { IS_PUBLIC_KEY } from '../../common/metadata/public.metadata';
import { Merchant } from '../../database/entities/merchant.entity';

@Injectable()
export class MerchantAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectRepository(Merchant)
    private readonly merchantRepository: Repository<Merchant>,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Missing or invalid Authorization header');
    }

    const secret = header.slice('Bearer '.length).trim();
    if (!secret) {
      throw new UnauthorizedException('Missing Bearer token');
    }

    const merchant = await this.merchantRepository.findOne({
      where: { apiSecret: secret },
    });
    if (!merchant) {
      throw new UnauthorizedException('Unknown merchant token');
    }

    request.merchant = merchant;
    return true;
  }
}
