export default function Home() {
  return (
    <main className="grid min-h-screen place-items-center bg-[#f7f8fa] px-5 py-8 text-[#162033]">
      <section
        className="w-full max-w-xl rounded-lg border border-[#d9dee8] bg-white p-6 sm:p-8"
        aria-labelledby="app-title"
      >
        <p className="mb-3 text-xs font-bold uppercase text-[#176a5e]">SEDUC/PI</p>
        <h1 id="app-title" className="text-4xl leading-tight font-bold sm:text-5xl">
          GESTOR GMAP
        </h1>
        <p className="mt-4 leading-7 text-[#5c667a]">Gerência de Materiais e Patrimônio</p>
      </section>
    </main>
  );
}
