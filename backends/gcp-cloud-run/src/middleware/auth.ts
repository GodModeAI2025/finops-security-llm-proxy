import { Request, Response, NextFunction } from "express";
import { getToken, revokeToken } from "../utils/firestore";
import { getAdminKey } from "../utils/secrets";
import { TokenDocument } from "../types";

// Extend Express Request to carry token info
declare global {
  namespace Express {
    interface Request {
      proxyToken?: TokenDocument;
    }
  }
}

/**
 * Authenticate proxy requests using ptk_... tokens.
 * Validates the token exists and is active.
 */
export async function proxyAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ptk_")) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Missing or invalid proxy token. Expected: Bearer ptk_...",
    });
  }

  const tokenId = authHeader.slice(7); // Remove "Bearer "

  try {
    const token = await getToken(tokenId);

    if (!token) {
      return res.status(401).json({
        error: "token_not_found",
        message: "Proxy token does not exist.",
      });
    }

    if (token.status === "revoked") {
      return res.status(403).json({
        error: "token_revoked",
        message: `Token was revoked: ${token.revoke_reason}`,
        revoked_at: token.revoked_at,
      });
    }

    // Check TTL
    if (token.rules.ttl_expires_at) {
      const expires = new Date(token.rules.ttl_expires_at);
      if (expires <= new Date()) {
        // Auto-revoke
        await revokeToken(token.id, "ttl_expired");
        return res.status(403).json({
          error: "token_expired",
          message: "Token TTL has expired. Token has been automatically revoked.",
        });
      }
    }

    req.proxyToken = token;
    next();
  } catch (err: any) {
    console.error("Auth error:", err);
    return res.status(500).json({ error: "auth_error", message: err.message });
  }
}

/**
 * Authenticate admin requests using the admin key.
 */
export async function adminAuth(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res.status(401).json({
      error: "unauthorized",
      message: "Missing admin key.",
    });
  }

  const providedKey = authHeader.slice(7);

  try {
    const adminKey = await getAdminKey();
    if (providedKey !== adminKey) {
      return res.status(403).json({
        error: "forbidden",
        message: "Invalid admin key.",
      });
    }
    next();
  } catch (err: any) {
    console.error("Admin auth error:", err);
    return res.status(500).json({ error: "auth_error", message: err.message });
  }
}
