import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import { KycController, SubmitBasicDto } from './kyc.controller';
import { RATE_LIMIT_KEY } from '../rate-limit/rate-limit.decorator';

const good = {
  idType: 'BVN', idNumber: '22222222222', firstName: 'John', lastName: 'Ajayi', dateOfBirth: '2000-05-01',
  address: { street: '1 Marina', city: 'Lagos', state: 'Lagos', lga: 'Ikeja' }, stateOfOrigin: 'Ogun', country: 'NG',
};
const errors = async (o: object) =>
  (await validate(plainToInstance(SubmitBasicDto, o), { whitelist: true, forbidNonWhitelisted: true })).map((e) => e.property);

describe('SubmitBasicDto', () => {
  it('accepts a complete submission', async () => expect(await errors(good)).toEqual([]));
  it('accepts names with accents, apostrophes and hyphens', async () =>
    expect(await errors({ ...good, firstName: 'Adébáyọ̀', lastName: "O'Neil-Smith" })).toEqual([]));
  it.each([['idNumber', '2222222222'], ['idNumber', '2222222222a'], ['idType', 'PASSPORT'], ['dateOfBirth', '01/05/2000'], ['country', 'GH'], ['firstName', '']])(
    'refuses %s = %p',
    async (k, v) => expect(await errors({ ...good, [k]: v })).toContain(k),
  );
  it('refuses a missing address part', async () => expect(await errors({ ...good, address: { street: 'x', city: 'y', state: 'Lagos' } })).toContain('address'));
  it('refuses unknown fields such as a phone', async () => expect((await errors({ ...good, phone: '0801' })).length).toBeGreaterThan(0));
});

describe('KycController routes', () => {
  const proto = KycController.prototype as unknown as Record<string, object>;
  it('has POST basic with the kyc.basic policy, GET states, and no tier1', () => {
    const names = Object.getOwnPropertyNames(KycController.prototype).filter((n) => n !== 'constructor');
    const paths = names.map((n) => Reflect.getMetadata(PATH_METADATA, proto[n])).filter(Boolean);
    expect(paths).toEqual(expect.arrayContaining(['basic', 'states']));
    expect(paths).not.toContain('tier1');
    expect(Reflect.getMetadata(RATE_LIMIT_KEY, proto.submitBasic)).toBe('kyc.basic');
    expect(Reflect.getMetadata(METHOD_METADATA, proto.submitBasic)).toBe(RequestMethod.POST);
  });
});
