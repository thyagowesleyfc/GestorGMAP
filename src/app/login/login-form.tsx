"use client";

import { useRouter } from "next/navigation";
import { type FormEvent, useState } from "react";

const GENERIC_LOGIN_ERROR = "Credenciais inv\u00e1lidas.";

type LoginResponse = {
  error?: string;
};

async function readLoginError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as LoginResponse;
    return body.error ?? GENERIC_LOGIN_ERROR;
  } catch {
    return GENERIC_LOGIN_ERROR;
  }
}

export function LoginForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submitLogin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setPending(true);

    const formData = new FormData(event.currentTarget);
    const loginIdentifier = String(formData.get("loginIdentifier") ?? "");
    const password = String(formData.get("password") ?? "");

    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          loginIdentifier,
          password
        })
      });

      if (!response.ok) {
        setError(await readLoginError(response));
        return;
      }

      router.replace("/");
      router.refresh();
    } catch {
      setError("N\u00e3o foi poss\u00edvel conectar ao GESTOR GMAP.");
    } finally {
      setPending(false);
    }
  }

  return (
    <form className="grid gap-5" onSubmit={submitLogin}>
      <div className="grid gap-2">
        <label className="text-sm font-bold text-[#253149]" htmlFor="loginIdentifier">
          Identificador de login
        </label>
        <input
          id="loginIdentifier"
          name="loginIdentifier"
          type="text"
          autoComplete="username"
          required
          className="min-h-12 rounded-md border border-[#c9d1df] bg-white px-3 text-base text-[#162033] outline-none transition-colors focus:border-[#176a5e] focus:ring-2 focus:ring-[#176a5e]/20"
        />
      </div>

      <div className="grid gap-2">
        <label className="text-sm font-bold text-[#253149]" htmlFor="password">
          Senha
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="min-h-12 rounded-md border border-[#c9d1df] bg-white px-3 text-base text-[#162033] outline-none transition-colors focus:border-[#176a5e] focus:ring-2 focus:ring-[#176a5e]/20"
        />
      </div>

      {error ? (
        <p
          className="rounded-md border border-[#f0b4a8] bg-[#fff3f0] px-3 py-2 text-sm font-medium text-[#9b2c1d]"
          role="alert"
        >
          {error}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="min-h-12 rounded-md bg-[#176a5e] px-5 text-sm font-bold text-white transition-colors hover:bg-[#12564d] focus:ring-2 focus:ring-[#176a5e] focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:bg-[#8aa9a4]"
      >
        {pending ? "Entrando..." : "Entrar"}
      </button>
    </form>
  );
}
