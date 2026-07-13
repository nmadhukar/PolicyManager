import { BadRequestException } from '@nestjs/common';
import { assertPasswordPolicy } from './password-policy';

describe('assertPasswordPolicy', () => {
  it('accepts a compliant password', () => {
    expect(() => assertPasswordPolicy('Str0ngPass')).not.toThrow();
  });

  it.each([
    ['too short', 'Ab1'],
    ['no digit', 'abcdefghij'],
    ['no letter', '1234567890'],
    ['trivial/common', 'password1'],
    ['single repeated char', 'aaaaaaaa'],
  ])('rejects %s with 400', (_label, pw) => {
    expect(() => assertPasswordPolicy(pw)).toThrow(BadRequestException);
  });

  it('surfaces the specific violations in the response body', () => {
    try {
      assertPasswordPolicy('short');
      fail('should have thrown');
    } catch (err) {
      const body = (err as BadRequestException).getResponse() as { errors: string[] };
      expect(Array.isArray(body.errors)).toBe(true);
      expect(body.errors.length).toBeGreaterThan(0);
    }
  });
});
