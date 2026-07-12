export { can, ROLES } from "./roles.js";
export type { Action, Role } from "./roles.js";

export { accountSchema, accountsFileSchema, parseAccountsFile, principalFor } from "./accounts.js";
export type { Account, ParseAccountsResult } from "./accounts.js";

export { hashPassword, verifyPassword } from "./password.js";

export { issueSession, issueSessionFor, verifySession } from "./session.js";
export type { SessionClaims, SessionVerification } from "./session.js";

export {
  SCIM_ERROR_SCHEMA_URN,
  SCIM_LIST_SCHEMA_URN,
  SCIM_PATCH_SCHEMA_URN,
  SCIM_USER_SCHEMA_URN,
  scimPatchActive,
  scimPatchSchema,
  scimToAccount,
  scimUserSchema,
  validateStoredRoles,
} from "./scim.js";
export type {
  ProvisionedAccount,
  ScimMappingContext,
  ScimPatch,
  ScimToAccountResult,
  ScimUser,
} from "./scim.js";

export {
  jwksSchema,
  mapOidcRoles,
  mapOidcTenant,
  oidcPrincipal,
  oidcRoleMappingSchema,
  oidcTenantMappingSchema,
  verifyIdToken,
} from "./oidc.js";
export type {
  IdTokenClaims,
  IdTokenVerification,
  Jwks,
  OidcRoleMapping,
  OidcTenantMapping,
  OidcVerifyOptions,
  TenantMapResult,
} from "./oidc.js";
