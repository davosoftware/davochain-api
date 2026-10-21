import { ConflictException, NotFoundException } from '@nestjs/common';
import { PayrepMock } from '../payrep/payrep.mock';
import { AdminController } from './admin.controller';

/** Only the fields the dev routes touch; the controller has many other collaborators. */
function controller(payrep: unknown, nodeEnv: string, accounts: Array<{ accountNumber: string; isPrimary: boolean }> = [{ accountNumber: '2012345678', isPrimary: true }]) {
  const c = Object.create(AdminController.prototype) as AdminController;
  Object.assign(c, {
    payrep,
    payrepCfg: { nodeEnv },
    virtualAccounts: { listForUser: jest.fn(async () => accounts) },
  });
  return c;
}

describe('dev Payrep routes (development and test only)', () => {
  it('simulate-deposit makes a deposit into the primary account and reports the webhook status', async () => {
    const mock = new PayrepMock({ port: 1 });
    const sim = jest.spyOn(mock, 'simulateDeposit').mockResolvedValue({ transactionId: 't1', webhookStatus: 200 });
    const c = controller(mock, 'development');
    await expect(c.simulatePayrepDeposit({ userId: 'u1', amount: '5000', payerName: 'ADA', status: 'success' } as never)).resolves.toEqual({ transactionId: 't1', webhookStatus: 200 });
    expect(sim).toHaveBeenCalledWith({ accountNumber: '2012345678', amount: '5000.00', senderName: 'ADA', status: 'success' });
  });

  it('409 when the user has no deposit account', async () => {
    const c = controller(new PayrepMock({ port: 1 }), 'test', []);
    await expect(c.simulatePayrepDeposit({ userId: 'u1', amount: '5' } as never)).rejects.toBeInstanceOf(ConflictException);
  });

  it('redeliver sends the webhook again', async () => {
    const mock = new PayrepMock({ port: 1 });
    jest.spyOn(mock, 'redeliver').mockResolvedValue(200);
    await expect(controller(mock, 'test').redeliverPayrepWebhook('t1')).resolves.toEqual({ transactionId: 't1', webhookStatus: 200 });
  });

  it('404 when Payrep is not the mock, or outside development and test', async () => {
    const real = { simulateDeposit: jest.fn() };
    await expect(controller(real, 'development').simulatePayrepDeposit({ userId: 'u1', amount: '5' } as never)).rejects.toBeInstanceOf(NotFoundException);
    await expect(controller(new PayrepMock({ port: 1 }), 'staging').redeliverPayrepWebhook('t1')).rejects.toBeInstanceOf(NotFoundException);
  });
});
