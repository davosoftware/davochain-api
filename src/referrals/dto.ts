import { IsString, MaxLength } from 'class-validator';

/**
 * The username somebody chooses instead of their generated code.
 *
 * Deliberately almost no rules here. Every real one lives in checkUsername,
 * which returns a sentence a person can act on — "A username can be at most 7
 * characters" rather than "username must be shorter than or equal to 7
 * characters". Repeating the bounds as decorators would let class-validator
 * answer first with the worse wording, and the better message would never be
 * seen.
 *
 * The cap here is only a guard against something absurd arriving.
 */
export class SetUsernameDto {
  @IsString()
  @MaxLength(64)
  username!: string;
}
