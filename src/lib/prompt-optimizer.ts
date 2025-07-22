import type { Template, ConversationStep } from "../app/types/unimarc"

/**
 * Interface que define a estrutura de um prompt otimizado para chamadas à API da OpenAI
 * Contém todos os parâmetros necessários para uma interação eficiente com os modelos de IA
 */
interface OptimizedPrompt {
    prompt: string      // Texto de entrada fornecido pelo utilizador/ contexto
    systemMessage: string       // Instrução de sistema que configura o comportamento da IA
    maxTokens: number       // Limite máximo de tokens que a IA pode gerar
    temperature: number      // Grau de aleatoriedade da resposta (0.0 = determinístico, 1.0 = mais criativo)
    model: "gpt-3.5-turbo" | "gpt-4-1106-preview"       // Modelo OpenAI utilizado
}

/**
 * Classe responsável pela construção inteligente de prompts para o fluxo de catalogação.
 * 
 * Implementa padrões de otimização para:
 * - Redução de custos (seleção de modelos mais econômicos quando possível)
 * - Maximização de precisão (ajuste fino de parâmetros por tipo de tarefa)
 * - Contextualização adequada (inclui apenas informações relevantes)
 * - Internacionalização (suporte a múltiplos idiomas)
 */
export class PromptOptimizer {
    /**
     * Método principal que direciona a construção do prompt conforme a etapa atual.
     * 
     * @param step - Fase atual do fluxo de catalogação:
     *               - "template-selection": Seleção inicial do template
     *               - "field-filling": Preenchimento de campos individuais
     *               - "confirmation": Validação final do registro
     * @param description - Descrição textual do item sendo catalogado
     * @param options - Objeto de configuração contendo:
     *                  - templates?: Lista de templates disponíveis (etapa 1)
     *                  - currentTemplate?: Template atual (etapas 2-3)
     *                  - filledFields?: Campos já preenchidos (etapas 2-3)
     *                  - remainingFields?: Campos pendentes (etapa 2)
     *                  - language?: Idioma preferencial (padrão: "pt")
     * @returns Objeto OptimizedPrompt pronto para uso na API OpenAI
     * @throws Error quando:
     *         - Etapa não é suportada
     *         - Template atual é undefined em etapas que o requerem
     *         - Não há campos restantes para preencher
     *         - Campo não existe no template especificado
     */
    buildPrompt(
        step: ConversationStep,
        description: string,
        options: {
            templates?: Template[]
            currentTemplate?: Template
            filledFields?: Record<string, any>
            remainingFields?: string[]
            language?: string
        } = {},
    ): OptimizedPrompt {
        // Valores padrão para evitar undefined
        const { templates = [], currentTemplate, filledFields = {}, remainingFields = [], language = "pt" } = options

        // Roteamento para o método específico de cada etapa
        switch (step) {
            case "template-selection":
                return this.buildTemplateSelectionPrompt(description, templates)

            case "field-filling":
                return this.buildFieldFillingPrompt(description, currentTemplate!, filledFields, remainingFields, language)

            case "confirmation":
                return this.buildConfirmationPrompt(filledFields)

            default:
                throw new Error(`Etapa não suportada: ${step}`)
        }
    }

    /**
     * Constrói prompt para seleção inicial do template UNIMARC.
     * 
     * Características:
     * - Formato extremamente conciso para forçar resposta específica
     * - Uso de modelo econômico (gpt-3.5-turbo)
     * - Temperatura baixa para respostas consistentes
     * 
     * @param description Descrição do material a catalogar
     * @param templates Lista de templates disponíveis
     * @returns Prompt otimizado para seleção de template
     */
    private buildTemplateSelectionPrompt(description: string, templates: Template[]): OptimizedPrompt {
        // Lista formatada de nomes de templates (ex: "Livro|Artigo|Tese")
        const templateNames = templates.map((t) => t.name).join("|")

        // Prompt com descrição do material e os templates disponíveis
        return {
            prompt: `Material: "${description}"\nTemplates: ${templateNames}\nMelhor:`,
            // Instrução para o modelo não gerar explicações, apenas um nome exato
            systemMessage: "Responda apenas com o nome exato do template mais adequado.",
            maxTokens: 20,      // Pequeno número de tokens, pois a resposta esperada é curta
            temperature: 0.1,       // Baixa aleatoriedade: queremos respostas determinísticas
            model: "gpt-3.5-turbo", // Modelo mais leve e barato para tarefas simples
        }
    }

    /**
     * Constrói prompt para preenchimento de campo específico.
     * 
     * Adaptações dinâmicas:
     * - Usa GPT-4 para campos complexos (ex: campos de descrição)
     * - Ajusta maxTokens conforme complexidade do campo
     * - Inclui contexto de campos já preenchidos
     * - Suporta múltiplos idiomas via parâmetro language
     * 
     * @param description Descrição do item
     * @param template Template atualmente selecionado
     * @param filledFields Campos já preenchidos (para contexto)
     * @param remainingFields Campos pendentes (foca no primeiro)
     * @param language Idioma preferido para nomes de campos
     * @returns Prompt otimizado para preenchimento de campo
     * @throws Error se não houver campos restantes ou campo não existir
     */
    private buildFieldFillingPrompt(
        description: string,
        template: Template,
        filledFields: Record<string, any>,
        remainingFields: string[],
        language: string,
    ): OptimizedPrompt {
        // Garante que existe pelo menos um campo por preencher
        if (remainingFields.length === 0) {     // O campo que será processado agora
            throw new Error("Nenhum campo restante para preencher")
        }

        const nextField = remainingFields[0]
        // Busca o campo no template atual (controlFields ou dataFields)
        const field = [...template.controlFields, ...template.dataFields].find((f) => f.tag === nextField)

        if (!field) {
            throw new Error(`Campo ${nextField} não encontrado no template`)
        }

        // Nome do campo, traduzido na linguagem definida
        const fieldName = field.translations.find((t) => t.language === language)?.name || nextField

        // Contexto adicional para campos já preenchidos (melhora precisão)
        const context = Object.keys(filledFields).length > 0 ? `\nJá preenchido: ${JSON.stringify(filledFields)}` : ""

        // Prompt simples e direto com contexto + campo a preencher
        const prompt = `"${description}"${context}\n${fieldName} [${nextField}]:`

        // Alguns campos requerem mais contexto (campos bibliográficos complexos)
        const isComplexField = ["100", "245", "260", "264", "520"].includes(nextField)

        return {
            prompt,
            systemMessage: `Forneça APENAS o valor conciso para o campo ${fieldName}. Não inclua explicações, introduções, conclusões ou qualquer texto adicional. Se a informação não estiver explicitamente disponível na descrição, responda com uma string vazia.`,
            maxTokens: isComplexField ? 100 : 50,       // Campos complexos têm mais espaço para resposta
            temperature: 0.1,       // Queremos respostas previsíveis
            model: isComplexField ? "gpt-4-1106-preview" : "gpt-3.5-turbo",     // Usa GPT-4 apenas se necessário
        }
    }

    /**
     * Constrói prompt para validação final do registro completo.
     * (Etapa opcional para verificação automatizada de qualidade)
     * 
     * @param filledFields Todos os campos preenchidos no registro
     * @returns Prompt para verificação de completude e correção
     */
    private buildConfirmationPrompt(filledFields: Record<string, any>): OptimizedPrompt {
        return {
            prompt: `Registro: ${JSON.stringify(filledFields)}\nCompleto e correto?`,
            systemMessage: 'Responda "SIM" se correto ou liste problemas brevemente.',
            maxTokens: 100,     // Espaço suficiente para listar múltiplos problemas
            temperature: 0.1,       // Leve criatividade para identificar issues
            model: "gpt-3.5-turbo",     // Modelo padrão para validação
        }
    }
}

/**
 * Instância singleton do PromptOptimizer.
 * 
 * Benefícios:
 * - Evita múltiplas instanciações
 * - Permite reutilização de cache interno (se implementado)
 * - Padroniza comportamento em toda a aplicação
 */
export const promptOptimizer = new PromptOptimizer()