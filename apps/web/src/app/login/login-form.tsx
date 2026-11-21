"use client";

import { ArrowLeftIcon, ArrowRightIcon, Loader2Icon, MailIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Label } from "@/components/ui/label";
import { authClient } from "@/lib/auth-client";

const emailSchema = z.email("Enter a valid email address");
const RESEND_SECONDS = 30;

interface Props {
  next: string;
  google: boolean;
  github: boolean;
  devOutbox: boolean;
}

function GoogleIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4">
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.24 1.4-1.7 4.1-5.5 4.1-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.5 14.6 2.5 12 2.5 6.8 2.5 2.6 6.7 2.6 12s4.2 9.5 9.4 9.5c5.4 0 9-3.8 9-9.2 0-.6-.07-1.1-.16-1.6H12z" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="size-4 fill-current">
      <path d="M12 .5a11.5 11.5 0 0 0-3.6 22.4c.6.1.8-.3.8-.6v-2c-3.2.7-3.9-1.5-3.9-1.5-.5-1.3-1.3-1.7-1.3-1.7-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.7-1.6-2.6-.3-5.3-1.3-5.3-5.7 0-1.3.5-2.3 1.2-3.1-.1-.3-.5-1.5.1-3.1 0 0 1-.3 3.2 1.2a11 11 0 0 1 5.8 0c2.2-1.5 3.2-1.2 3.2-1.2.6 1.6.2 2.8.1 3.1.8.8 1.2 1.8 1.2 3.1 0 4.4-2.7 5.4-5.3 5.7.4.4.8 1.1.8 2.2v3.2c0 .3.2.7.8.6A11.5 11.5 0 0 0 12 .5z" />
    </svg>
  );
}

export function LoginForm({ next, google, github, devOutbox }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [emailError, setEmailError] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [pending, setPending] = useState<null | "send" | "verify" | "google" | "github">(null);
  const [cooldown, setCooldown] = useState(0);
  const verifying = useRef(false);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  async function sendCode(e?: React.FormEvent) {
    e?.preventDefault();
    const parsed = emailSchema.safeParse(email.trim());
    if (!parsed.success) {
      setEmailError(parsed.error.issues[0]?.message ?? "Enter a valid email address");
      return;
    }
    setEmailError(null);
    setPending("send");
    const { error } = await authClient.emailOtp.sendVerificationOtp({ email: parsed.data, type: "sign-in" });
    setPending(null);
    if (error) {
      setEmailError(
        error.status === 429 ? "Too many requests. Wait a minute and try again." : (error.message ?? "Could not send the code"),
      );
      return;
    }
    setEmail(parsed.data);
    setCode("");
    setCodeError(null);
    setStep("code");
    setCooldown(RESEND_SECONDS);
  }

  async function verify(value: string) {
    if (verifying.current || value.length !== 6) return;
    verifying.current = true;
    setPending("verify");
    setCodeError(null);
    const { error } = await authClient.signIn.emailOtp({ email, otp: value });
    if (error) {
      verifying.current = false;
      setPending(null);
      setCode("");
      setCodeError(
        error.status === 429
          ? "Too many attempts. Wait a minute and try again."
          : error.code === "TOO_MANY_ATTEMPTS"
            ? "Too many wrong codes. Request a new one."
            : "That code is incorrect or has expired.",
      );
      return;
    }
    router.replace(next);
    router.refresh();
  }

  async function social(provider: "google" | "github") {
    setPending(provider);
    const { error } = await authClient.signIn.social({ provider, callbackURL: next, errorCallbackURL: "/login" });
    if (error) {
      setPending(null);
      setEmailError(error.message ?? "Could not start sign-in");
    }
  }

  const busy = pending !== null;

  return (
    <AnimatePresence mode="wait" initial={false}>
      {step === "email" ? (
        <motion.div
          key="email"
          initial={{ opacity: 0, x: -12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: -12 }}
          transition={{ duration: 0.18 }}
        >
          <h1 className="text-2xl font-semibold tracking-tight">Sign in to Conduit</h1>
          <p className="mt-2 text-sm text-muted-foreground">New here? The same step creates your account.</p>

          {(google || github) && (
            <div className="mt-8 grid gap-2">
              {google && (
                <Button variant="outline" size="lg" className="h-10" disabled={busy} onClick={() => social("google")}>
                  {pending === "google" ? <Loader2Icon className="animate-spin" /> : <GoogleIcon />}
                  Continue with Google
                </Button>
              )}
              {github && (
                <Button variant="outline" size="lg" className="h-10" disabled={busy} onClick={() => social("github")}>
                  {pending === "github" ? <Loader2Icon className="animate-spin" /> : <GitHubIcon />}
                  Continue with GitHub
                </Button>
              )}
              <div className="my-4 flex items-center gap-3 text-xs text-muted-foreground">
                <span className="h-px flex-1 bg-border" />
                or with email
                <span className="h-px flex-1 bg-border" />
              </div>
            </div>
          )}

          <form onSubmit={sendCode} noValidate className={google || github ? "grid gap-3" : "mt-8 grid gap-3"}>
            <div className="grid gap-1.5">
              <Label htmlFor="email">Work email</Label>
              <Input
                id="email"
                type="email"
                inputMode="email"
                autoComplete="email"
                autoFocus
                placeholder="you@company.com"
                className="h-10"
                value={email}
                aria-invalid={emailError ? true : undefined}
                aria-describedby={emailError ? "email-error" : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  if (emailError) setEmailError(null);
                }}
              />
              {emailError && (
                <p id="email-error" role="alert" className="text-sm text-destructive">
                  {emailError}
                </p>
              )}
            </div>
            <Button type="submit" size="lg" className="h-10" disabled={busy}>
              {pending === "send" ? <Loader2Icon className="animate-spin" /> : <MailIcon data-icon="inline-start" />}
              Email me a sign-in code
            </Button>
          </form>
          <p className="mt-6 text-xs text-muted-foreground">
            By continuing you agree to the terms of service and privacy policy.
          </p>
        </motion.div>
      ) : (
        <motion.div
          key="code"
          initial={{ opacity: 0, x: 12 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 12 }}
          transition={{ duration: 0.18 }}
        >
          <button
            type="button"
            onClick={() => setStep("email")}
            className="mb-6 inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeftIcon className="size-4" /> Use a different email
          </button>
          <h1 className="text-2xl font-semibold tracking-tight">Check your inbox</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>. It expires in 10
            minutes.
          </p>
          {devOutbox && (
            <p className="mt-3 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground">
              Development mode: no email provider is configured.{" "}
              <a href="/dev/outbox" target="_blank" className="font-medium text-primary underline-offset-4 hover:underline">
                Open the local outbox
              </a>{" "}
              to read the code.
            </p>
          )}

          <form
            className="mt-8 grid gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              void verify(code);
            }}
          >
            <Label htmlFor="otp">Sign-in code</Label>
            <InputOTP
              id="otp"
              maxLength={6}
              autoFocus
              inputMode="numeric"
              pattern="^[0-9]+$"
              value={code}
              disabled={pending === "verify"}
              aria-invalid={codeError ? true : undefined}
              onChange={(v) => {
                setCode(v);
                if (codeError) setCodeError(null);
              }}
              onComplete={(v: string) => void verify(v)}
            >
              <InputOTPGroup>
                {Array.from({ length: 6 }, (_, i) => (
                  <InputOTPSlot key={i} index={i} className="size-11 text-base" />
                ))}
              </InputOTPGroup>
            </InputOTP>
            {codeError && (
              <p role="alert" className="text-sm text-destructive">
                {codeError}
              </p>
            )}
            <Button type="submit" size="lg" className="h-10" disabled={code.length !== 6 || pending === "verify"}>
              {pending === "verify" ? <Loader2Icon className="animate-spin" /> : <ArrowRightIcon data-icon="inline-start" />}
              Continue
            </Button>
          </form>
          <div className="mt-5 text-sm text-muted-foreground">
            Didn&apos;t get it?{" "}
            {cooldown > 0 ? (
              <span>Resend in {cooldown}s</span>
            ) : (
              <button
                type="button"
                className="font-medium text-primary underline-offset-4 hover:underline disabled:opacity-50"
                disabled={busy}
                onClick={() => void sendCode()}
              >
                Send a new code
              </button>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
