"use client"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useState, useEffect } from "react"
import QuestionDisplay from "@/components/question-display"
import type { CatalogResponse, ConversationState } from "@/app/types/unimarc"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { BookOpen } from "lucide-react"

export default function HomePage() {
  const [currentResponse, setCurrentResponse] = useState<CatalogResponse | null>(null)
  const [loading, setLoading] = useState(false)
  const [description, setDescription] = useState("")
  const [userResponse, setUserResponse] = useState("")
  const [conversationState, setConversationState] = useState<ConversationState | null>(null)

  // Auto-continuação para template-selected, bulk-auto-filled, e field-auto-filled
  useEffect(() => {
    console.log("useEffect triggered - currentResponse:", currentResponse?.type)
    console.log("useEffect triggered - loading:", loading)
    console.log("useEffect triggered - conversationState:", conversationState?.step)

    if (loading) {
      console.log("useEffect: Skipping - already loading")
      return
    }

    if (!currentResponse || !conversationState) {
      console.log("useEffect: Skipping - no response or conversation state")
      return
    }

    // Auto-continuar apenas para estes tipos de resposta
    const shouldAutoContinue = [
      "template-selected",
      "bulk-auto-filled",
      "field-auto-filled"
    ].includes(currentResponse.type)

    if (shouldAutoContinue) {
      console.log(`useEffect: Auto-continuing for ${currentResponse.type}`)
      const timer = setTimeout(() => {
        handleUserResponse()
      }, 1500) // 1.5 segundos para melhor feedback visual

      return () => clearTimeout(timer)
    }
  }, [currentResponse, loading, conversationState])

  const handleInitialRequest = async () => {
    console.log("handleInitialRequest called with description:", description)
    setLoading(true)
    try {
      const payload = { description }
      console.log("Sending initial payload:", payload)

      const res = await fetch("/api/uni-dialog", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      const data: CatalogResponse = await res.json()
      console.log("Received initial response:", data)

      setCurrentResponse(data)
      setConversationState(data.conversationState || null)
    } catch (error) {
      console.error("Erro ao iniciar a conversação:", error)
    } finally {
      setLoading(false)
    }
  }

  const handleUserResponse = async (directResponse?: string) => {
    console.log("handleUserResponse called with:", directResponse || userResponse)

    setLoading(true)
    try {
      const payload = {
        description,
        conversationState,
        userResponse: directResponse || userResponse || undefined,
      }
      console.log("Sending payload:", payload)

      const res = await fetch("/api/uni-dialog", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      })

      const data: CatalogResponse = await res.json()
      console.log("Received response:", data)

      setCurrentResponse(data)
      setConversationState(data.conversationState || null)

      // Só limpa a resposta se não for uma resposta direta dos botões
      if (!directResponse) {
        setUserResponse("")
      }
    } catch (error) {
      console.error("Erro ao enviar resposta do utilizador:", error)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 flex flex-col items-center justify-center p-6">
      <div className="max-w-4xl w-full">
        <Card className="p-8 space-y-6 flex flex-col items-center bg-white rounded-xl border border-gray-200">
          <CardHeader className="w-full text-center">
            <CardTitle className="flex items-center justify-center gap-3 text-2xl font-bold text-gray-800">
              <BookOpen className="w-6 h-6" />
              <span>Sistema de Catalogação UNIMARC Otimizado</span>
            </CardTitle>
          </CardHeader>

          <CardContent className="space-y-6 w-full">
            {/* Status info */}
            {conversationState && (
              <div className="mb-4 p-4 bg-blue-50 rounded-lg border border-blue-200 w-full max-w-lg mx-auto shadow-sm">
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <Badge variant="outline" className="mr-2">{conversationState.step}</Badge>
                    <span className="text-blue-700 font-medium">
                      {Object.keys(conversationState.filledFields).length} campos preenchidos
                    </span>
                  </div>
                  <div className="text-blue-600">{conversationState.remainingFields.length} restantes</div>
                </div>
                {(conversationState.autoFilledCount ?? 0) > 0 && (
                  <div className="mt-2 text-xs text-green-600">
                    ✨ {conversationState.autoFilledCount ?? 0} campos preenchidos automaticamente
                  </div>
                )}
              </div>
            )}

            {/* Input inicial */}
            {!currentResponse && (
              <div className="w-full max-w-md mx-auto space-y-4">
                <Input
                  className="shadow-sm rounded-lg border-gray-300"
                  placeholder="Ex: Livro 'Memorial do Convento' de José Saramago"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={loading}
                />
                <Button
                  onClick={handleInitialRequest}
                  className="w-full rounded-lg shadow hover:shadow-md transition"
                  disabled={loading}
                >
                  {loading ? "A iniciar..." : "Iniciar Catalogação"}
                </Button>
              </div>
            )}

            {/* Respostas e estados */}
            {currentResponse && (
              <div className="w-full max-w-lg mx-auto space-y-6">
                {/* Pergunta ao usuário */}
                {currentResponse.type === "field-question" && (
                  <>
                    <QuestionDisplay response={currentResponse} />
                    <div className="flex gap-2 mt-4">
                      <Input
                        placeholder="A sua resposta..."
                        value={userResponse}
                        onChange={(e) => setUserResponse(e.target.value)}
                        onKeyPress={(e) => e.key === "Enter" && handleUserResponse()}
                        disabled={loading}
                        className="rounded-lg border-gray-300 shadow-sm"
                      />
                      <Button onClick={() => handleUserResponse()} disabled={loading} className="rounded-lg">
                        {loading ? "A enviar..." : "Enviar"}
                      </Button>
                    </div>
                  </>
                )}

                {/* Confirmação de repetição */}
                {currentResponse.type === "repeat-confirmation" && (
                  <Card className="p-4 bg-amber-50 border border-amber-200 text-amber-800 rounded-lg shadow">
                    <p className="mb-4">{currentResponse.question}</p>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleUserResponse("sim")}
                        className="flex-1 bg-amber-500 hover:bg-amber-600"
                        disabled={loading}
                      >
                        {loading ? "Processando..." : "Sim"}
                      </Button>
                      <Button
                        onClick={() => handleUserResponse("não")}
                        className="flex-1 bg-white text-amber-800 border border-amber-300 hover:bg-amber-50"
                        variant="outline"
                        disabled={loading}
                      >
                        {loading ? "Processando..." : "Não"}
                      </Button>
                    </div>
                  </Card>
                )}

                {/* Template selecionado */}
                {currentResponse.type === "template-selected" && (
                  <Card className="p-4 bg-green-50 border border-green-200 text-green-800 rounded-lg shadow">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">Template selecionado:</p>
                        <p className="text-lg">{currentResponse.template?.name}</p>
                      </div>
                      {loading && (
                        <div className="flex items-center text-sm">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-600 mr-2"></div>
                          Analisando...
                        </div>
                      )}
                    </div>
                  </Card>
                )}

                {/* Preenchimento automático em massa */}
                {currentResponse.type === "bulk-auto-filled" && (
                  <Card className="p-4 bg-lime-50 border border-lime-200 text-lime-800 rounded-lg shadow">
                    <div className="flex items-center justify-between mb-3">
                      <p className="font-semibold">🎉 Preenchimento Automático Concluído!</p>
                      {loading && (
                        <div className="flex items-center text-sm">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-lime-600 mr-2"></div>
                          Continuando...
                        </div>
                      )}
                    </div>
                    <p className="mb-3">{currentResponse.message}</p>
                    {currentResponse.filledFields && (
                      <div className="bg-white p-3 rounded border">
                        <p className="font-medium mb-2">Campos preenchidos automaticamente:</p>
                        <div className="space-y-2">
                          {Object.entries(currentResponse.filledFields).map(([field, value]) => (
                            <div key={field} className="flex items-start gap-2">
                              <Badge variant="secondary" className="text-xs">{field}</Badge>
                              <span className="text-sm flex-1">
                                {typeof value === "object" ? (
                                  <div className="space-y-1">
                                    {Object.entries(value as Record<string, any>).map(([subfield, subvalue]) => (
                                      <div key={subfield} className="text-xs">
                                        <span className="font-mono">${subfield}:</span> {String(subvalue)}
                                      </div>
                                    ))}
                                  </div>
                                ) : (
                                  String(value)
                                )}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </Card>
                )}

                {/* Registro completo */}
                {currentResponse.type === "record-complete" && (
                  <Card className="p-4 bg-purple-50 border border-purple-200 text-purple-800 rounded-lg shadow">
                    <p>Todos os campos preenchidos! Clique para confirmar e gravar.</p>
                    <Button onClick={() => handleUserResponse()} className="mt-4 rounded-lg" disabled={loading}>
                      Confirmar e Gravar
                    </Button>
                  </Card>
                )}

                {/* Registro salvo */}
                {currentResponse.type === "record-saved" && (
                  <Card className="p-4 bg-blue-50 border border-blue-200 text-blue-800 rounded-lg shadow">
                    <p><strong>{currentResponse.message}</strong></p>
                    <p className="mt-2 text-sm">UNIMARC gerado:</p>
                    <pre className="bg-gray-100 p-3 rounded text-xs whitespace-pre-wrap mt-1">{currentResponse.textUnimarc}</pre>
                    <Button
                      onClick={() => {
                        setCurrentResponse(null)
                        setConversationState(null)
                        setDescription("")
                      }}
                      className="mt-4 rounded-lg"
                    >
                      Iniciar Nova Catalogação
                    </Button>
                  </Card>
                )}

                {/* Erro */}
                {currentResponse.type === "error" && (
                  <Card className="p-4 bg-red-50 border border-red-200 text-red-800 rounded-lg shadow">
                    <p>Erro: {currentResponse.error}</p>
                    {currentResponse.details && <p className="text-sm">{currentResponse.details}</p>}
                    <Button
                      onClick={() => {
                        setCurrentResponse(null)
                        setConversationState(null)
                        setDescription("")
                      }}
                      className="mt-4 rounded-lg"
                    >
                      Tentar Novamente
                    </Button>
                  </Card>
                )}

                {/* Template não encontrado */}
                {currentResponse.type === "template-not-found" && (
                  <Card className="p-4 bg-orange-50 border border-orange-200 text-orange-800 rounded-lg shadow">
                    <p>{currentResponse.error}</p>
                    {currentResponse.options && (
                      <ul className="list-disc list-inside mt-2">
                        {currentResponse.options.map((opt) => (
                          <li key={opt.id}>{opt.name}</li>
                        ))}
                      </ul>
                    )}
                    <Button
                      onClick={() => {
                        setCurrentResponse(null)
                        setConversationState(null)
                        setDescription("")
                      }}
                      className="mt-4 rounded-lg"
                    >
                      Tentar Outra Descrição
                    </Button>
                  </Card>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  )
}