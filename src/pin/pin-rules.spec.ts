import { checkNewPin, PIN_LENGTH } from './pin-rules';

describe('checkNewPin', () => {
  it('accepts a 4-digit PIN that is not easy to guess', () => {
    expect(PIN_LENGTH).toBe(4);
    expect(checkNewPin('4826')).toBeNull();
    expect(checkNewPin('7391')).toBeNull();
  });

  it.each(['123', '12345', '12a4', ' 1234', '', '١٢٣٤'])('refuses %p: exactly 4 digits', (pin) => {
    expect(checkNewPin(pin)).toBe('Your PIN must be exactly 4 digits.');
  });

  it.each(['0000', '1111', '9999'])('refuses %p: one digit repeated', (pin) => {
    expect(checkNewPin(pin)).toMatch(/too easy to guess/);
  });

  it.each(['1234', '0123', '6789', '4321', '9876', '3210'])('refuses %p: a straight run', (pin) => {
    expect(checkNewPin(pin)).toMatch(/too easy to guess/);
  });

  it.each(['1212', '2020', '1122', '1004', '2580'])('refuses %p: a common pattern', (pin) => {
    expect(checkNewPin(pin)).toMatch(/too easy to guess/);
  });
});
