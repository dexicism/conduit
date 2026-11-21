import "server-only";
import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { nextCookies } from "better-auth/next-js";
import { emailOTP } from "better-auth/plugins";
import { db, mongoClient } from "./db";
import { env, oauthProviders } from "./env";
import { sendEmail, signInCodeEmail } from "./email";
import { ensurePersonalWorkspace } from "./workspaces";

export const auth = betterAuth({
  appName: "Conduit",
  baseURL: env.APP_URL,
  secret: env.AUTH_SECRET,
  database: mongodbAdapter(db, { client: mongoClient }),
  // Passwordless only: email codes plus optional Google/GitHub.
  emailAndPassword: { enabled: false },
  socialProviders: {
    ...(oauthProviders.google
      ? { google: { clientId: env.GOOGLE_CLIENT_ID!, clientSecret: env.GOOGLE_CLIENT_SECRET! } }
      : {}),
    ...(oauthProviders.github
      ? { github: { clientId: env.GITHUB_CLIENT_ID!, clientSecret: env.GITHUB_CLIENT_SECRET! } }
      : {}),
  },
  account: {
    accountLinking: { enabled: true, trustedProviders: ["google", "github", "email-otp"] },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30,
    updateAge: 60 * 60 * 24,
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  rateLimit: {
    enabled: true,
    window: 60,
    max: 120,
    customRules: {
      "/email-otp/send-verification-otp": { window: 60, max: 5 },
      "/sign-in/email-otp": { window: 60, max: 10 },
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await ensurePersonalWorkspace({ id: user.id, name: user.name, email: user.email });
        },
      },
    },
  },
  plugins: [
    emailOTP({
      otpLength: 6,
      expiresIn: 10 * 60,
      allowedAttempts: 5,
      async sendVerificationOTP({ email, otp, type }) {
        if (type !== "sign-in") return;
        await sendEmail(signInCodeEmail(email, otp));
      },
    }),
    nextCookies(), // must stay last
  ],
});

export type Session = typeof auth.$Infer.Session;
