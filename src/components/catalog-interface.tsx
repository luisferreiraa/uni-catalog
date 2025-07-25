"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Loader2, BookOpen, Disc, Film, CheckCircle, Bug } from "lucide-react"
import type { CatalogResponse, ConversationState } from "@/app/types/unimarc"
import QuestionDisplay from "@/components/question-display"     // Componente para exibição de perguntas formatadas

/**
 * Componente principal para interface de catalogação UNIMARC
 * Gerencia todo o fluxo e conversa com o servidor de catalogação
 */
export default function CatalogInterface() {
    // Estados do componente
    const [description, setDescription] = useState("")      // Descrição do material a ser catalogado
    const [userResponse, setUserResponse] = useState("")        // Resposta do utilizador às perguntas
    const [conversationState, setConversationState] = useState<ConversationState | null>(null)      // Estado atual da conversa
    const [response, setResponse] = useState<CatalogResponse | null>(null)      // Última resposta da API
    const [loading, setLoading] = useState(false)       // Estado de carregamento
    const [history, setHistory] = useState<Array<{ type: string; content: string; timestamp: Date }>>([])       // Histórico da conversa
    const [debugMode, setDebugMode] = useState(false)       // Modo de debug

    // Ref para acessar o estado mais recente da conversa em callbacks assíncronos
    const conversationStateRef = useRef<ConversationState | null>(null)

    // Atualiza a ref sempre que o estado muda
    useEffect(() => {
        conversationStateRef.current = conversationState
    }, [conversationState])

    /**
     * Adiciona uma entrada ao histórico da conversa
     * @param type Tipo da mensagem ('user', 'system' ou 'error')
     * @param content Conteúdo da mensagem
     */
    const addToHistory = (type: string, content: string) => {
        setHistory((prev) => [...prev, { type, content, timestamp: new Date() }])
    }

    /**
     * Efeito para auto-continuar o fluxo após certas respostas da API
     * - Template selecionado
     * - Campo auto-preenchido
     */
    useEffect(() => {
        if (loading) return     // Não fazer nada durante carregamentos

        // Auto-continua após seleção de template ou campo auto-preenchido
        if (response?.type === "template-selected" || response?.type === "field-auto-filled") {
            const timer = setTimeout(() => {
                // Usa a ref para obter o estado mais recente
                const latestState = conversationStateRef.current
                if (latestState?.step === "field-filling" && latestState.remainingFields.length > 0) {
                    console.log("useEffect: Auto-continuing to next field...")
                    handleSubmit(false) // Aciona o próximo passo
                } else if (latestState?.step === "field-filling" && latestState.remainingFields.length === 0) {
                    // Todos os campos preenchidos, aciona record-complete
                    console.log("useEffect: All fields filled, triggering record-complete...")
                    handleSubmit(false) // Aciona o passo de confirmação
                }
            }, 500) // Pequeno atraso para feedback visual e propagação do estado
            return () => clearTimeout(timer) // Limpa o timeout
        }
    }, [response?.type, loading]) // Dependências: reagi apenas ao tipo de resposta e estado de carregamento

    /**
     * Manipula o envio de dados para a API
     * @param isInitial Indica se é a primeira chamada (descrição inicial)
     */
    const handleSubmit = async (isInitial = false) => {
        // Previne múltiplas submissões ou chamadas quando já estiver a carregar
        if (loading) return

        // Se não é inicial, e não há resposta do utilizador, e estamos atualmente a pedir uma pergunta, então retorna.
        // Isso impede a auto-continuação quando a entrada do utilizador é esperada.
        if (!isInitial && !userResponse.trim() && response?.type === "field-question") {
            console.log("handleSubmit: Skipping call - waiting for user input.")
            return
        }

        setLoading(true)
        try {
            // Preparar payload para a API
            const payload = {
                description: description,       // Envia sempre a descrição original
                userResponse: isInitial ? undefined : userResponse,
                conversationState: isInitial ? null : conversationStateRef.current, // Usa a ref para o estado mais recente
                language: "pt",
            }

            if (debugMode) {
                console.log("Sending payload:", payload)
            }

            // Registar no histórico
            if (isInitial) {
                addToHistory("user", `Descrição: ${description}`)
            } else if (userResponse) {
                addToHistory("user", userResponse)
            }

            // Chamada à API
            const res = await fetch("/api/uni-dialog", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            })

            const data: CatalogResponse = await res.json()

            if (debugMode) {
                console.log("Received response:", data)
            }

            setResponse(data)
            setConversationState(data.conversationState || null) // Atualiza o estado

            // Processar reposta e atualizar histórico
            switch (data.type) {
                case "template-selected":
                    addToHistory("system", `Template selecionado: ${data.template?.name}`)
                    if (data.template?.description) {
                        addToHistory("system", data.template.description)
                    }
                    // useEffect irá lidar com a auto-continuação
                    break
                case "field-question":
                    // Não adicionamos a string 'question' ao histórico aqui,
                    // pois o QuestionDisplay irá renderizá-la graficamente.
                    // Se quisermos manter um histórico de texto simples, podemos adicionar aqui.
                    addToHistory("system", data.question || "") // Mantido para o histórico de texto simples
                    break
                case "field-auto-filled":
                    addToHistory("system", `Campo ${data.field} preenchido automaticamente: ${data.value}`)
                    // useEffect irá lidar com a auto-continuação
                    break
                case "record-complete":
                    addToHistory("system", "Registro completo! Por favor, confirme para gravar.")
                    break
                case "record-saved":
                    addToHistory("system", data.message || "Registro gravado!")
                    break
                case "template-not-found":
                    addToHistory("system", data.error || "Template não encontrado")
                    break
                case "error":
                    addToHistory("error", data.error || "Erro desconhecido")
                    break
            }

            if (!isInitial) {
                setUserResponse("")
            }
        } catch (error) {
            console.error("Erro:", error)
            addToHistory("error", "Erro de comunicação com o servidor")
        } finally {
            setLoading(false)
        }
    }

    /**
     * Manipula a seleção manual do template
     * @param templateName Nome do template selecionado
     */
    const handleTemplateSelection = async (templateName: string) => {
        setLoading(true)
        try {
            const payload = {
                description: `${description} [TEMPLATE: ${templateName}]`,
                conversationState: null,
                language: "pt",
            }
            const res = await fetch("/api/uni-dialog", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            })
            const data: CatalogResponse = await res.json()
            setResponse(data)
            setConversationState(data.conversationState || null)
            addToHistory("user", `Template selecionado manualmente: ${templateName}`)
            // useEffect irá lidar com a auto-continuação
        } catch (error) {
            console.error("Erro:", error)
        } finally {
            setLoading(false)
        }
    }

    // Reinicia toda a conversa
    const resetConversation = () => {
        setDescription("")
        setUserResponse("")
        setConversationState(null)
        setResponse(null)
        setHistory([])
    }

    /**
     * Retorna ícone apropriado para o tipo de material
     * @param templateName Nome do template
     * @returns Componente de ícone
     */
    const getIcon = (templateName?: string) => {
        if (!templateName) return <BookOpen className="w-4 h-4" />
        if (templateName.toLowerCase().includes("música") || templateName.toLowerCase().includes("cd")) {
            return <Disc className="w-4 h-4" />
        }
        if (templateName.toLowerCase().includes("filme") || templateName.toLowerCase().includes("dvd")) {
            return <Film className="w-4 h-4" />
        }
        return <BookOpen className="w-4 h-4" />
    }

    // Renderização do componente
    return (
        <div className="max-w-4xl mx-auto p-6 space-y-6">
            {/* Card principal */}
            <Card>
                <CardHeader>
                    <CardTitle className="flex items-center gap-2 justify-between">
                        <div className="flex items-center gap-2">
                            <BookOpen className="w-5 h-5" />
                            Sistema de Catalogação UNIMARC Otimizado
                        </div>
                        {/* Botão de debug */}
                        <Button
                            variant="outline"
                            size="sm"
                            onClick={() => setDebugMode(!debugMode)}
                            className={debugMode ? "bg-yellow-100" : ""}
                        >
                            <Bug className="w-4 h-4 mr-1" />
                            Debug
                        </Button>
                    </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                    {/* Painel de debug */}
                    {debugMode && conversationState && (
                        <div className="bg-yellow-50 p-3 rounded text-xs">
                            <div>
                                <strong>Step:</strong> {conversationState.step}
                            </div>
                            <div>
                                <strong>Filled:</strong> {JSON.stringify(conversationState.filledFields)}
                            </div>
                            <div>
                                <strong>Remaining:</strong> {JSON.stringify(conversationState.remainingFields)}
                            </div>
                            <div>
                                <strong>Asked Field:</strong> {conversationState.askedField || "none"}
                            </div>
                        </div>
                    )}

                    {/* Formulário inicial */}
                    {!conversationState && (
                        <div className="space-y-4">
                            <div>
                                <label className="text-sm font-medium">Descrição do material a catalogar:</label>
                                <Input
                                    value={description}
                                    onChange={(e) => setDescription(e.target.value)}
                                    placeholder="Ex: CD 'Made in Japan' dos Deep Purple"
                                    className="mt-1"
                                />
                            </div>
                            <Button onClick={() => handleSubmit(true)} disabled={!description.trim() || loading} className="w-full">
                                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                Iniciar Catalogação
                            </Button>
                        </div>
                    )}

                    {/* Seleção manual de template */}
                    {response?.type === "template-not-found" && (
                        <div className="space-y-4">
                            <div className="text-sm text-muted-foreground">{response.error}</div>
                            <div className="grid gap-2">
                                {response.options?.map((option) => (
                                    <Button
                                        key={option.id}
                                        variant="outline"
                                        onClick={() => handleTemplateSelection(option.name)}
                                        className="justify-start"
                                        disabled={loading}
                                    >
                                        {getIcon(option.name)}
                                        {option.name}
                                    </Button>
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Pergunta de campo */}
                    {response?.type === "field-question" && (
                        <div className="space-y-4">
                            {/* Substitua a linha abaixo pelo QuestionDisplay */}
                            <QuestionDisplay response={response} />
                            <div className="flex gap-2">
                                <Input
                                    value={userResponse}
                                    onChange={(e) => setUserResponse(e.target.value)}
                                    placeholder="Digite sua resposta..."
                                    onKeyPress={(e) => e.key === "Enter" && handleSubmit(false)}
                                />
                                <Button onClick={() => handleSubmit(false)} disabled={!userResponse.trim() || loading}>
                                    {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : "Enviar"}
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* Confirmação de registo */}
                    {response?.type === "record-complete" && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-green-600">
                                <CheckCircle className="w-4 h-4" />
                                <span className="font-medium">Registro completo!</span>
                            </div>
                            <div className="bg-muted p-4 rounded-lg">
                                <h4 className="font-medium mb-2">Campos preenchidos:</h4>
                                <div className="space-y-1 text-sm">
                                    {Object.entries(response.record || {}).map(([field, value]) => (
                                        <div key={field} className="flex gap-2">
                                            <Badge variant="outline">{field}</Badge>
                                            <span>
                                                {typeof value === "object" && value !== null ? JSON.stringify(value, null, 2) : String(value)}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                            <Button onClick={() => handleSubmit(false)} disabled={loading} className="w-full">
                                {loading ? <Loader2 className="w-4 h-4 animate-spin mr-2" /> : null}
                                Gravar Registro
                            </Button>
                        </div>
                    )}

                    {/* Confirmação de gravação */}
                    {response?.type === "record-saved" && (
                        <div className="space-y-4">
                            <div className="flex items-center gap-2 text-green-600">
                                <CheckCircle className="w-4 h-4" />
                                <span className="font-medium">{response.message}</span>
                            </div>
                            <Button onClick={resetConversation} variant="outline" className="w-full bg-transparent">
                                Nova Catalogação
                            </Button>
                        </div>
                    )}

                    {/* Status atual */}
                    {conversationState && (
                        <div className="text-xs text-muted-foreground border-t pt-4">
                            <div>Etapa: {conversationState.step}</div>
                            <div>Campos preenchidos: {Object.keys(conversationState.filledFields).length}</div>
                            <div>Campos restantes: {conversationState.remainingFields.length}</div>
                            {conversationState.autoFilledCount && (
                                <div>Preenchimento automático: {conversationState.autoFilledCount} campos</div>
                            )}
                        </div>
                    )}
                </CardContent>
            </Card>

            {/* Histórico da conversa */}
            {history.length > 0 && (
                <Card>
                    <CardHeader>
                        <CardTitle className="text-lg">Histórico da Conversa</CardTitle>
                    </CardHeader>
                    <CardContent>
                        <div className="space-y-2 max-h-96 overflow-y-auto">
                            {history.map((entry, index) => (
                                <div
                                    key={index}
                                    className={`p-2 rounded text-sm ${entry.type === "user"
                                        ? "bg-blue-50 border-l-2 border-blue-500"
                                        : entry.type === "system"
                                            ? "bg-gray-50 border-l-2 border-gray-500"
                                            : "bg-red-50 border-l-2 border-red-500"
                                        }`}
                                >
                                    <div className="flex items-center gap-2 mb-1">
                                        {entry.type === "user" ? "👤" : entry.type === "system" ? "🤖" : "⚠️"}
                                        <span className="text-xs text-muted-foreground">{entry.timestamp.toLocaleTimeString()}</span>
                                    </div>
                                    <div>{entry.content}</div>
                                </div>
                            ))}
                        </div>
                    </CardContent>
                </Card>
            )}
        </div>
    )
}
