"use client"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useState, useEffect } from "react"
import QuestionDisplay from "@/components/question-display"
import type { CatalogResponse, ConversationState } from "@/app/types/unimarc"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { BookOpen, Edit } from "lucide-react" // Importar Edit icon

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
    const shouldAutoContinue = ["template-selected", "bulk-auto-filled", "field-auto-filled"].includes(
      currentResponse.type,
    )
    if (shouldAutoContinue) {
      console.log(`useEffect: Auto-continuing for ${currentResponse.type}`)
      const timer = setTimeout(() => {
        handleUserResponse()
      }, 1500) // 1.5 segundos para melhor feedback visual
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

  const handleUserResponse = async (directResponse?: string, fieldToEdit?: string) => {
    // Adicionado fieldToEdit
    console.log("handleUserResponse called with:", directResponse || userResponse)
    setLoading(true)
    try {
      const payload = {
        description,
        conversationState,
        userResponse: directResponse !== undefined ? directResponse : userResponse,
        fieldToEdit, // Incluir fieldToEdit no payload
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

  const handleReviewFields = () => {
    handleUserResponse("__REVIEW_FIELDS__") // Comando especial para o backend
  }

  const handleEditField = (fieldTag: string) => {
    handleUserResponse("__EDIT_FIELD__", fieldTag) // Comando especial e o campo a editar
  }

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-6 text-gray-900 font-poppins">
      <div className="max-w-4xl w-full">
        <Card className="p-8 space-y-6 flex flex-col items-center bg-white rounded-xl border border-gray-200 shadow-lg min-h-[500px] justify-between">
          <CardHeader className="w-full text-center">
            <CardTitle className="flex items-center justify-center gap-3 text-3xl font-extrabold text-gray-900">
              <BookOpen className="w-8 h-8 text-blue-600" />
              <span>Sistema de Catalogação UNIMARC</span>
            </CardTitle>
            <p className="text-gray-700 text-sm mt-2">Otimizado com IA para eficiência máxima</p>
          </CardHeader>
          <CardContent className="space-y-6 w-full flex-grow flex flex-col justify-center">
            {/* Status info */}
            {conversationState && (
              <div className="mb-4 p-4 bg-gray-50 rounded-lg border border-gray-200 w-full max-w-lg mx-auto shadow-sm">
                <div className="flex items-center justify-between text-sm">
                  <div>
                    <Badge variant="secondary" className="mr-2 bg-gray-200 text-gray-800 border-gray-300">
                      {conversationState.step}
                    </Badge>
                    <span className="text-gray-700 font-medium">
                      {Object.keys(conversationState.filledFields).length} campos preenchidos
                    </span>
                  </div>
                  <div className="text-gray-500">{conversationState.remainingFields.length} restantes</div>
                </div>
                {(conversationState.autoFilledCount ?? 0) > 0 && (
                  <div className="mt-2 text-xs text-emerald-600">
                    ✨ {conversationState.autoFilledCount ?? 0} campos preenchidos automaticamente
                  </div>
                )}
              </div>
            )}
            {/* Input inicial */}
            {!currentResponse && (
              <div className="w-full max-w-md mx-auto space-y-4">
                <Input
                  className="shadow-sm rounded-lg border-gray-300 bg-white text-gray-900 placeholder:text-gray-500 focus:border-blue-500 focus:ring-blue-500"
                  placeholder="Ex: Livro 'Memorial do Convento' de José Saramago"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  disabled={loading}
                />
                <Button
                  onClick={handleInitialRequest}
                  className="w-full rounded-lg shadow-md bg-blue-600 hover:bg-blue-700 text-white font-semibold transition-all duration-200 ease-in-out transform hover:scale-105"
                  disabled={loading}
                >
                  {loading ? "A iniciar..." : "Iniciar Catalogação"}
                </Button>
              </div>
            )}
            {/* Respostas e estados */}
            {currentResponse && (
              <div className="w-full max-w-lg mx-auto space-y-6">
                {/* Botão de Revisão/Edição */}
                {conversationState &&
                  conversationState.step !== "template-selection" &&
                  conversationState.step !== "completed" && (
                    <div className="flex justify-center mt-4">
                      <Button
                        onClick={handleReviewFields}
                        disabled={loading}
                        variant="outline"
                        className="rounded-lg border-blue-500 text-blue-600 hover:bg-blue-50 hover:text-blue-700 transition-all duration-200 ease-in-out bg-transparent"
                      >
                        <Edit className="w-4 h-4 mr-2" /> Rever e Editar Campos
                      </Button>
                    </div>
                  )}

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
                        className="rounded-lg border-gray-300 bg-white text-gray-900 placeholder:text-gray-500 shadow-sm focus:border-blue-500 focus:ring-blue-500"
                      />
                      <Button
                        onClick={() => handleUserResponse()}
                        disabled={loading}
                        className="rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                      >
                        {loading ? "A enviar..." : "Enviar"}
                      </Button>
                    </div>
                  </>
                )}
                {/* Confirmação de repetição */}
                {currentResponse.type === "repeat-confirmation" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-amber-600 rounded-lg shadow-sm">
                    <p className="mb-4">{currentResponse.question}</p>
                    <div className="flex gap-2">
                      <Button
                        onClick={() => handleUserResponse("sim")}
                        className="flex-1 bg-amber-500 hover:bg-amber-600 text-white font-semibold"
                        disabled={loading}
                      >
                        {loading ? "A processar..." : "Sim"}
                      </Button>
                      <Button
                        onClick={() => handleUserResponse("não")}
                        className="flex-1 bg-transparent text-amber-600 border border-amber-500 hover:bg-amber-500/10 font-semibold"
                        variant="outline"
                        disabled={loading}
                      >
                        {loading ? "A processar..." : "Não"}
                      </Button>
                    </div>
                  </Card>
                )}
                {/* Template selecionado */}
                {currentResponse.type === "template-selected" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-green-600 rounded-lg shadow-sm">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="font-semibold">Template selecionado:</p>
                        <p className="text-lg">{currentResponse.template?.name}</p>
                      </div>
                      {loading && (
                        <div className="flex items-center text-sm text-gray-500">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-green-600 mr-2"></div>A
                          analisar...
                        </div>
                      )}
                    </div>
                  </Card>
                )}
                {/* Preenchimento automático em massa */}
                {currentResponse.type === "bulk-auto-filled" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-lime-600 rounded-lg shadow-sm">
                    <div className="flex items-center justify-between mb-3">
                      <p className="font-semibold">🎉 Preenchimento Automático Concluído!</p>
                      {loading && (
                        <div className="flex items-center text-sm text-gray-500">
                          <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-lime-600 mr-2"></div>
                          Continuando...
                        </div>
                      )}
                    </div>
                    <p className="mb-3">{currentResponse.message}</p>
                    {currentResponse.filledFields && (
                      <div className="bg-gray-100 p-3 rounded border border-gray-200">
                        <p className="font-medium mb-2 text-gray-800">Campos preenchidos automaticamente:</p>
                        <div className="space-y-2">
                          {Object.entries(currentResponse.filledFields).map(([field, value]) => (
                            <div key={field} className="flex items-start gap-2">
                              <Badge variant="secondary" className="text-xs bg-gray-200 text-gray-700">
                                {field}
                              </Badge>
                              <span className="text-sm flex-1 text-gray-800">
                                {typeof value === "object" ? (
                                  <div className="space-y-1">
                                    {Object.entries(value as Record<string, any>).map(([subfield, subvalue]) => (
                                      <div key={subfield} className="text-xs text-gray-700">
                                        <span className="font-mono text-gray-600">${subfield}:</span> {String(subvalue)}
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
                {/* Exibição de campos para revisão */}
                {currentResponse.type === "review-fields-display" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-blue-600 rounded-lg shadow-sm">
                    <p className="font-semibold mb-4">Campos Preenchidos:</p>
                    <div className="space-y-3 max-h-60 overflow-y-auto pr-2">
                      {currentResponse.filledFields && Object.keys(currentResponse.filledFields).length > 0 ? (
                        Object.entries(currentResponse.filledFields).map(([fieldTag, value]) => (
                          <div
                            key={fieldTag}
                            className="flex items-center justify-between p-2 bg-white rounded-md border border-gray-200 shadow-sm"
                          >
                            <div className="flex-1">
                              <Badge variant="secondary" className="text-xs bg-gray-200 text-gray-700 mr-2">
                                {fieldTag}
                              </Badge>
                              <span className="text-sm text-gray-800">
                                {typeof value === "object"
                                  ? JSON.stringify(value) // Para objetos/arrays, mostra o JSON
                                  : String(value)}
                              </span>
                            </div>
                            <Button
                              onClick={() => handleEditField(fieldTag)}
                              variant="ghost"
                              size="sm"
                              className="text-blue-500 hover:bg-blue-100"
                              disabled={loading}
                            >
                              Editar
                            </Button>
                          </div>
                        ))
                      ) : (
                        <p className="text-gray-600">Nenhum campo preenchido ainda.</p>
                      )}
                    </div>
                    <Button
                      onClick={() => handleUserResponse("__CONTINUE_FROM_REVIEW__")} // Comando para continuar
                      className="mt-4 w-full rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                      disabled={loading}
                    >
                      {loading ? "A continuar..." : "Continuar Catalogação"}
                    </Button>
                  </Card>
                )}
                {/* Registro completo */}
                {currentResponse.type === "record-complete" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-purple-600 rounded-lg shadow-sm">
                    <p>Todos os campos preenchidos! Clique para confirmar e gravar.</p>
                    <Button
                      onClick={() => handleUserResponse()}
                      className="mt-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                      disabled={loading}
                    >
                      Confirmar e Gravar
                    </Button>
                  </Card>
                )}
                {/* Registro salvo */}
                {currentResponse.type === "record-saved" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-blue-600 rounded-lg shadow-sm">
                    <p>
                      <strong>{currentResponse.message}</strong>
                    </p>
                    <p className="mt-2 text-sm text-gray-500">UNIMARC gerado:</p>
                    <pre className="bg-gray-100 p-3 rounded text-xs whitespace-pre-wrap mt-1 text-gray-800 border border-gray-200">
                      {currentResponse.textUnimarc}
                    </pre>
                    <Button
                      onClick={() => {
                        setCurrentResponse(null)
                        setConversationState(null)
                        setDescription("")
                      }}
                      className="mt-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                    >
                      Iniciar Nova Catalogação
                    </Button>
                  </Card>
                )}
                {/* Erro */}
                {currentResponse.type === "error" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-red-600 rounded-lg shadow-sm">
                    <p>Erro: {currentResponse.error}</p>
                    {currentResponse.details && <p className="text-sm text-gray-500">{currentResponse.details}</p>}
                    <Button
                      onClick={() => {
                        setCurrentResponse(null)
                        setConversationState(null)
                        setDescription("")
                      }}
                      className="mt-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold"
                    >
                      Tentar Novamente
                    </Button>
                  </Card>
                )}
                {/* Template não encontrado */}
                {currentResponse.type === "template-not-found" && (
                  <Card className="p-4 bg-gray-50 border border-gray-200 text-orange-600 rounded-lg shadow-sm">
                    <p>{currentResponse.error}</p>
                    {currentResponse.options && (
                      <ul className="list-disc list-inside mt-2 text-gray-700">
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
                      className="mt-4 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold"
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
