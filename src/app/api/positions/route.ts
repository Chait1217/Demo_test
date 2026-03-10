import { NextRequest } from "next/server";
import { getPositionsForWallet } from "@/server/positionsStore";

export async function GET(req: NextRequest) {
  const walletAddress = req.nextUrl.searchParams.get("walletAddress");
  if (!walletAddress) {
    return new Response("walletAddress required", { status: 400 });
  }
  const data = getPositionsForWallet(walletAddress);
  return Response.json(data);
}

