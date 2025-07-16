import type { Template, ConversationStep } from "../app/types/unimarc"

interface OptimizedPrompt {
    prompt: string
    systemMessage: string
    maxTokens: number
    temperature: number
    model: "gpt-3.5-turbo" | "gpt-4-1106-preview"
}

export class PromptOptimizer {
    /**
     * Gera prompts otimizados para cada etapa
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
        const { templates = [], currentTemplate, filledFields = {}, remainingFields = [], language = "pt" } = options

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

    private buildTemplateSelectionPrompt(description: string, templates: Template[]): OptimizedPrompt {
        // Prompt ultra-conciso para seleção de template
        const templateNames = templates.map((t) => t.name).join("|")

        return {
            prompt: `Material: "${description}"\nTemplates: ${templateNames}\nMelhor:`,
            systemMessage: "Responda apenas com o nome exato do template mais adequado.",
            maxTokens: 20,
            temperature: 0.1,
            model: "gpt-3.5-turbo", // Modelo mais barato para seleção simples
        }
    }

    private buildFieldFillingPrompt(
        description: string,
        template: Template,
        filledFields: Record<string, any>,
        remainingFields: string[],
        language: string,
    ): OptimizedPrompt {
        if (remainingFields.length === 0) {
            throw new Error("Nenhum campo restante para preencher")
        }

        const nextField = remainingFields[0]
        const field = [...template.controlFields, ...template.dataFields].find((f) => f.tag === nextField)

        if (!field) {
            throw new Error(`Campo ${nextField} não encontrado no template`)
        }

        const fieldName = field.translations.find((t) => t.language === language)?.name || nextField

        // Contexto mínimo necessário
        const context = Object.keys(filledFields).length > 0 ? `\nJá preenchido: ${JSON.stringify(filledFields)}` : ""

        // Prompt ultra-conciso
        const prompt = `"${description}"${context}\n${fieldName} [${nextField}]:`

        // Usa GPT-4 apenas para campos complexos
        const isComplexField = ["100", "245", "260", "264", "520"].includes(nextField)

        return {
            prompt,
            systemMessage: `Extraia apenas a informação para o campo ${fieldName} em formato UNIMARC. Seja conciso.`,
            maxTokens: isComplexField ? 100 : 50,
            temperature: 0.1,
            model: isComplexField ? "gpt-4-1106-preview" : "gpt-3.5-turbo",
        }
    }

    private buildConfirmationPrompt(filledFields: Record<string, any>): OptimizedPrompt {
        return {
            prompt: `Registro: ${JSON.stringify(filledFields)}\nCompleto e correto?`,
            systemMessage: 'Responda "SIM" se correto ou liste problemas brevemente.',
            maxTokens: 100,
            temperature: 0.1,
            model: "gpt-3.5-turbo",
        }
    }
}

export const promptOptimizer = new PromptOptimizer()