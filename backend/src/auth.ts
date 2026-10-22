import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose'

import type { Config } from './config.js'
import { ApiError } from './shared/errors.js'

interface OpenIdConfiguration {
  issuer: string
  jwks_uri: string
}

export class AuthService {
  private discovery?: Promise<{ issuer: string; jwks: ReturnType<typeof createRemoteJWKSet> }>

  constructor(private readonly config: Config) {}

  async actor(authorization: string | undefined): Promise<string> {
    if (!this.config.IES_AUTH_ENABLED) return 'local-demo-user'
    if (!authorization?.startsWith('Bearer ')) throw new ApiError(401, 'Authentication required', 'AUTH_REQUIRED')
    const token = authorization.slice('Bearer '.length).trim()
    try {
      const { issuer, jwks } = await this.identityProvider()
      const result = await jwtVerify(token, jwks, { issuer, audience: this.config.JWT_AUDIENCE })
      return actorClaim(result.payload)
    } catch (error) {
      if (error instanceof ApiError) throw error
      throw new ApiError(401, 'Invalid access token', 'INVALID_TOKEN')
    }
  }

  private identityProvider() {
    if (!this.discovery) {
      this.discovery = (async () => {
        if (!this.config.JWT_ISSUER_URI) throw new ApiError(503, 'Identity provider is not configured', 'AUTH_NOT_CONFIGURED')
        const url = `${this.config.JWT_ISSUER_URI.replace(/\/$/, '')}/.well-known/openid-configuration`
        const response = await fetch(url, { signal: AbortSignal.timeout(5_000) })
        if (!response.ok) throw new Error('OpenID discovery failed')
        const document = await response.json() as OpenIdConfiguration
        return { issuer: document.issuer, jwks: createRemoteJWKSet(new URL(document.jwks_uri)) }
      })()
    }
    return this.discovery
  }
}

function actorClaim(payload: JWTPayload): string {
  const claims = payload as JWTPayload & { preferred_username?: string; upn?: string }
  return claims.preferred_username ?? claims.upn ?? claims.sub ?? 'authenticated-user'
}
