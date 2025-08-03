import { NextResponse } from "next/server"
import { databaseService } from "@/lib/database"

export const runtime = "nodejs"

export async function GET() {
    try {
        const authors = await databaseService.getAuthorsWithRecordCount()
        return NextResponse.json(authors)
    } catch (error) {
        console.error("Erro na API de autores:", error)
        return NextResponse.json(
            {
                error: "Erro ao buscar autores",
                details: error instanceof Error ? error.message : "Erro desconhecido",
            },
            { status: 500 },
        )
    }
}