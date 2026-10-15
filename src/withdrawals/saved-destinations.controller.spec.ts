import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SavedDestinationsController } from './saved-destinations.controller';
import { AddBankAccountDto, AddCryptoAddressDto } from './dto';
import { REQUIRED_ACTION_KEY } from '../levels/requires-action.decorator';

const route = (name: string, key: string) =>
  Reflect.getMetadata(key, (SavedDestinationsController.prototype as unknown as Record<string, () => void>)[name]);

describe('Saved destination routes', () => {
  it('adding needs the level rule that allows that withdrawal; listing and removing do not', () => {
    expect(route('addBank', REQUIRED_ACTION_KEY)).toBe('NGN_WITHDRAW');
    expect(route('addCrypto', REQUIRED_ACTION_KEY)).toBe('CRYPTO_WITHDRAW');
    for (const name of ['listBanks', 'listCrypto', 'removeBank', 'removeCrypto']) expect(route(name, REQUIRED_ACTION_KEY)).toBeUndefined();
  });

  it('a bank account number must be 10 digits, and the password is required', async () => {
    const bad = plainToInstance(AddBankAccountDto, { bankCode: '058', accountNumber: '012345678' });
    const fields = (await validate(bad)).map((e) => e.property).sort();
    expect(fields).toEqual(['accountNumber', 'password']);
    const good = plainToInstance(AddBankAccountDto, { bankCode: '058', accountNumber: '0123456789', password: 'pw', nickname: 'Salary' });
    expect(await validate(good)).toHaveLength(0);
  });

  it('a crypto address needs coin, network, address and password', async () => {
    const fields = (await validate(plainToInstance(AddCryptoAddressDto, {}))).map((e) => e.property).sort();
    expect(fields).toEqual(['address', 'asset', 'network', 'password']);
  });
});
