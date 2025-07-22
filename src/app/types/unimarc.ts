export interface Translation {
    id: string
    language: string
    name: string
    tips?: string[]
}

export interface ControlField {
    id: string
    tag: string
    translations: Translation[]
}

export interface SubFieldDef {
    id: string
    code: string
    name: string
}

export interface DataField {
    id: string
    tag: string
    translations: Translation[]
    subFieldDef: SubFieldDef[]
}

export interface Template {
    id: string
    name: string
    controlFields: ControlField[]
    dataFields: DataField[]
}

export interface TemplatesResponse {
    templates: Template[]
}

export type ConversationStep = "template-selection" | "field-filling" | "confirmation" | "completed"

export interface ConversationState {
    step: ConversationStep
    currentTemplate?: Template
    filledFields: Record<string, any>
    remainingFields: string[]
    askedField?: string
    autoFilledCount?: number
}

export interface CatalogRequest {
    description: string
    language?: string
    conversationState?: ConversationState
    userResponse?: string
}

export interface CatalogResponse {
    type:
    | "template-selected"
    | "field-question"
    | "field-auto-filled"
    | "record-complete"
    | "record-saved"
    | "template-not-found"
    | "error"
    conversationState?: ConversationState
    template?: { id: string; name: string; description?: string }
    field?: string
    question?: string
    value?: string
    record?: Record<string, any>
    recordId?: string
    validation?: string
    message?: string
    error?: string
    details?: string
    options?: Array<{ name: string; id: string }>
    tips?: string[]
    textUnimarc?: string
}