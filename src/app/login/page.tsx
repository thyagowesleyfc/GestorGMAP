import type { Metadata } from "next";

import { LoginForm } from "./login-form";

export const metadata: Metadata = {
  title: "Entrar | GESTOR GMAP"
};

export default function LoginPage() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f8fa] px-5 py-8 text-[#162033]">
      <section
        className="w-full max-w-md rounded-lg border border-[#d9dee8] bg-white p-6 sm:p-8"
        aria-labelledby="login-title"
      >
        <p className="mb-3 text-xs font-bold uppercase text-[#176a5e]">GESTOR GMAP</p>
        <h1 id="login-title" className="text-3xl leading-tight font-bold text-[#162033]">
          Entrar
        </h1>
        <p className="mt-2 mb-6 text-sm text-[#5c667a]">
          {"Ger\u00eancia de Materiais e Patrim\u00f4nio"}
        </p>
        <LoginForm />
      </section>
    </main>
  );
}
