import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const JWT_EXPIRES_IN = (process.env.JWT_EXPIRES_IN || "7d") as string | number;

export interface JwtPayload {
  userId: string;
  email: string;
}

export interface ResetTokenPayload {
  userId: string;
  email: string;
  purpose: "reset-password";
}

export function signAccessToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN as jwt.SignOptions["expiresIn"],
  });
}

export function signRefreshToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: "30d" as jwt.SignOptions["expiresIn"],
  });
}

export function signResetToken(payload: ResetTokenPayload): string {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: "15m" as jwt.SignOptions["expiresIn"],
  });
}

export function verifyToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET) as JwtPayload;
}

export function verifyResetToken(token: string): ResetTokenPayload {
  return jwt.verify(token, JWT_SECRET) as ResetTokenPayload;
}
