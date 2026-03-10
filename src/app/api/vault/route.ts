// This route is now unused since vault reads/writes are fully on-chain via wagmi/viem.
export async function GET() {
  return new Response("Vault API moved on-chain", { status: 410 });
}

export async function POST() {
  return new Response("Vault API moved on-chain", { status: 410 });
}

