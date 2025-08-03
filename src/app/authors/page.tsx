import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { User } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import Link from "next/link"
import { Button } from "@/components/ui/button"

interface AuthorData {
    id: string
    name: string
    recordCount: number
}

export default async function AuthorsPage() {
    let authors: AuthorData[] = []
    let error: string | null = null

    try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_URL}/api/authors`, {
            cache: "no-store", // Garante que os dados são sempre frescos
        })

        if (!res.ok) {
            const errorData = await res.json()
            throw new Error(errorData.error || "Erro ao carregar autores")
        }
        authors = await res.json()
    } catch (e) {
        error = e instanceof Error ? e.message : "Erro desconhecido ao carregar autores."
        console.error("Failed to fetch authors:", e)
    }

    return (
        <div className="min-h-screen bg-gray-50 flex flex-col items-center p-6 text-gray-900 font-poppins">
            <div className="max-w-4xl w-full">
                <Card className="p-8 space-y-6 flex flex-col items-center bg-white rounded-xl border border-gray-200 shadow-lg min-h-[500px]">
                    <CardHeader className="w-full text-center">
                        <CardTitle className="flex items-center justify-center gap-3 text-3xl font-extrabold text-gray-900">
                            <User className="w-8 h-8 text-blue-600" />
                            <span>Autores Catalogados</span>
                        </CardTitle>
                        <p className="text-gray-700 text-sm mt-2">Lista de autores e o número de registos associados</p>
                    </CardHeader>
                    <CardContent className="space-y-4 w-full flex-grow">
                        {error ? (
                            <div className="text-red-600 text-center p-4 bg-red-50 border border-red-200 rounded-lg">
                                <p>{error}</p>
                                <p className="text-sm text-gray-500 mt-2">Verifique a consola para mais detalhes.</p>
                            </div>
                        ) : authors.length === 0 ? (
                            <div className="text-gray-600 text-center p-4 bg-gray-50 border border-gray-200 rounded-lg">
                                <p>Nenhum autor encontrado ainda.</p>
                                <p className="text-sm text-gray-500 mt-2">Comece a catalogar livros para ver os autores aqui!</p>
                            </div>
                        ) : (
                            <div className="grid gap-3">
                                {authors.map((author) => (
                                    <div
                                        key={author.id}
                                        className="flex items-center justify-between p-3 bg-gray-100 rounded-lg border border-gray-200 shadow-sm"
                                    >
                                        <span className="text-lg font-medium text-gray-800">{author.name}</span>
                                        <Badge className="bg-blue-100 text-blue-800 hover:bg-blue-100">
                                            {author.recordCount} {author.recordCount === 1 ? "livro" : "livros"}
                                        </Badge>
                                    </div>
                                ))}
                            </div>
                        )}
                    </CardContent>
                    <div className="w-full text-center mt-6">
                        <Link href="/" passHref>
                            <Button className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold">
                                Voltar à Catalogação
                            </Button>
                        </Link>
                    </div>
                </Card>
            </div>
        </div>
    )
}
