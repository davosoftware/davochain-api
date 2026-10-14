import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { RegisterDto } from './dto';

const base = { email: 'a@b.test', password: 'Str0ng!Passw0rd-long', firstName: 'A', lastName: 'B' };

it('requires a phone number at registration (spec §1)', async () => {
  const without = await validate(plainToInstance(RegisterDto, base));
  expect(without.map((e) => e.property)).toContain('phone');
  const withPhone = await validate(plainToInstance(RegisterDto, { ...base, phone: '+2348012345678' }));
  expect(withPhone.map((e) => e.property)).not.toContain('phone');
});

it('still checks the phone format', async () => {
  const bad = await validate(plainToInstance(RegisterDto, { ...base, phone: 'call me' }));
  expect(bad.map((e) => e.property)).toContain('phone');
});
