import 'reflect-metadata';
import { HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { Prisma } from '@prisma/client';
import { AttachDocumentDto } from '../kyc/kyc.controller';
import { ReviewKycDto } from '../admin/dto';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * L1 (PROJECT_REVIEW): bad input that reached the database came back as a 500.
 *  - a KYC document "type" outside the list, and an admin review "tier" outside
 *    the list, are now refused by validation (400);
 *  - a database "already exists" (P2002) is a 409 and "not found" (P2025) a
 *    404, everywhere, instead of a 500.
 */
const errors = async (cls: new () => object, body: Record<string, unknown>) =>
  (await validate(plainToInstance(cls, body))).map((e) => e.property);

describe('L1: values outside their list are refused, not a 500', () => {
  it('a KYC document type must be one of the document types', async () => {
    // H8: the type is the only field; storage location, kind and size are the server's to decide.
    expect(await errors(AttachDocumentDto, { type: 'PASSPORT' })).toEqual([]);
    expect(await errors(AttachDocumentDto, { type: 'BANANA' })).toEqual(['type']);
    expect(await errors(AttachDocumentDto, { type: 'BVN' })).toEqual(['type']);
  });

  it('an admin review tier must be a real tier', async () => {
    expect(await errors(ReviewKycDto, { approve: true, tier: 'TIER_1' })).toEqual([]);
    expect(await errors(ReviewKycDto, { approve: true, tier: 'TIER_99' })).toEqual(['tier']);
  });
});

describe('L1: database "already exists" and "not found" are 409 and 404', () => {
  function host() {
    const sent: { status?: number; body?: unknown } = {};
    const res = { status: (s: number) => ((sent.status = s), res), json: (b: unknown) => ((sent.body = b), res) };
    return { sent, host: { switchToHttp: () => ({ getResponse: () => res, getRequest: () => ({ url: '/v1/x' }) }) } as never };
  }
  const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError('db says no', { code, clientVersion: 'x' });

  it('P2002 (unique) → 409', () => {
    const { sent, host: h } = host();
    new PrismaExceptionFilter().catch(prismaError('P2002'), h);
    expect(sent).toEqual({ status: HttpStatus.CONFLICT, body: { statusCode: 409, message: 'That already exists.' } });
  });

  it('P2025 (record not found) → 404', () => {
    const { sent, host: h } = host();
    new PrismaExceptionFilter().catch(prismaError('P2025'), h);
    expect(sent).toEqual({ status: HttpStatus.NOT_FOUND, body: { statusCode: 404, message: 'Not found.' } });
  });

  it('any other database error is a plain 500 that reveals nothing', () => {
    const { sent, host: h } = host();
    new PrismaExceptionFilter().catch(prismaError('P2003'), h);
    expect(sent).toEqual({ status: 500, body: { statusCode: 500, message: 'Something went wrong on our side.' } });
  });
});
