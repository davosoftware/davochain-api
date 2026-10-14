/**
 * The admin_audit_log actor for things the platform does by itself: an
 * automatic sanctions block, a recovered call. Inserted by the kyc_dojah_basic
 * migration as an inactive admin with no usable password, so it can be named in
 * the audit trail but can never sign in.
 */
export const SYSTEM_ACTOR_ID = '00000000-0000-0000-0000-000000000001';
