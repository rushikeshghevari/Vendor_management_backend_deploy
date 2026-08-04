import crypto from 'node:crypto';

import { env } from '@/config/env';
import { RefreshToken } from '@/modules/auth/refreshToken.model';
import { User, type IUser } from '@/modules/user/user.model';
import { ApiError } from '@/utils/ApiError';
import { durationFromNow } from '@/utils/time';
import {
  signAccessToken,
  signRefreshToken,
  verifyRefreshToken,
} from '@/utils/jwt';

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
}

async function issueTokens(user: IUser): Promise<AuthTokens> {
  const accessToken = signAccessToken({
    sub: user.id,
    role: user.role,
    department: user.department?.toString(),
  });

  const tokenId = crypto.randomUUID();
  await RefreshToken.create({
    user: user.id,
    tokenId,
    expiresAt: durationFromNow(env.jwtRefreshExpiresIn),
  });

  const refreshToken = signRefreshToken({ sub: user.id, tokenId });

  return { accessToken, refreshToken };
}

function toPublicUser(user: IUser) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    department: user.department,
  };
}

export const authService = {
  async login(email: string, password: string) {
    const user = await User.findOne({ email }).select('+password');
    if (!user || !user.isActive) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    const matches = await user.comparePassword(password);
    if (!matches) {
      throw ApiError.unauthorized('Invalid email or password');
    }

    user.lastLoginAt = new Date();
    await user.save();

    const tokens = await issueTokens(user);
    return { ...tokens, user: toPublicUser(user) };
  },

  async refresh(refreshToken: string) {
    let payload;
    try {
      payload = verifyRefreshToken(refreshToken);
    } catch {
      throw ApiError.unauthorized('Invalid or expired refresh token');
    }

    const stored = await RefreshToken.findOne({ tokenId: payload.tokenId });
    if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
      throw ApiError.unauthorized('Refresh token has been revoked or expired');
    }

    const user = await User.findById(payload.sub);
    if (!user || !user.isActive) {
      throw ApiError.unauthorized('Account is inactive or no longer exists');
    }

    // Rotate: revoke the used token, then issue a fresh pair.
    stored.revokedAt = new Date();
    await stored.save();

    return issueTokens(user);
  },

  async logout(refreshToken: string) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      await RefreshToken.updateOne({ tokenId: payload.tokenId }, { revokedAt: new Date() });
    } catch {
      // Token already invalid/expired — logout is a no-op in that case.
    }
  },

  async getProfile(userId: string) {
    // Deliberately not populated — `department` stays a plain id here, consistent with
    // the login response shape (`toPublicUser`), since callers only need the id to look
    // up the full department record from the Departments list already in the RTK cache.
    const user = await User.findById(userId);
    if (!user) throw ApiError.notFound('User not found');
    return toPublicUser(user);
  },
};
