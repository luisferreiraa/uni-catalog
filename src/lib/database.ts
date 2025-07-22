import { prisma } from "./prisma"
import type { Template, DataField } from "@/app/types/unimarc"

export interface SaveRecordData {
    templateId: string
    templateName: string
    templateDesc?: string
    filledFields: Record<string, any>
    template: Template
    textUnimarc: string
}

export class DatabaseService {
    /**
     * Salva um registro UNIMARC na base de dados
     */
    async saveRecord(data: SaveRecordData): Promise<string> {
        try {
            const { templateId, templateName, templateDesc, filledFields, template, textUnimarc } = data

            // Cria o registro principal
            const catalogRecord = await prisma.catalogRecord.create({
                data: {
                    templateName,
                    templateDesc: templateDesc || `Registro ${templateName}`,
                    recordTemplateId: templateId,
                    textUnimarc,
                    fields: {
                        create: this.prepareFields(filledFields, template),
                    },
                },
                include: {
                    fields: true,
                },
            })

            return catalogRecord.id
        } catch (error) {
            console.error("Erro ao salvar registro:", error)
            throw new Error("Falha ao salvar registro na base de dados")
        }
    }

    /**
     * Prepara os campos para inserção na base de dados
     */
    private prepareFields(filledFields: Record<string, any>, template: Template) {
        const fieldsToCreate = []

        for (const [tag, value] of Object.entries(filledFields)) {
            // Encontra o campo no template
            const controlField = template.controlFields.find((f) => f.tag === tag)
            const dataField = template.dataFields.find((f) => f.tag === tag)

            if (controlField) {
                // Campo de controle
                fieldsToCreate.push({
                    tag,
                    value: String(value),
                    subfields: {},
                    fieldType: "CONTROL" as const,
                })
            } else if (dataField) {
                // Campo de dados - pode ter subcampos
                const subfields = this.parseSubfields(value, dataField)

                fieldsToCreate.push({
                    tag,
                    value: String(value),
                    subfields,
                    fieldType: "DATA" as const,
                })
            }
        }

        return fieldsToCreate
    }

    /**
     * Analisa e estrutura subcampos para campos de dados
     */
    private parseSubfields(value: any, dataField: DataField): Record<string, string> {
        const subfields: Record<string, string> = {}

        // Se o valor é uma string simples, coloca no subcampo 'a' (principal)
        if (typeof value === "string") {
            subfields.a = value
            return subfields
        }

        // Se o valor já é um objeto com subcampos
        if (typeof value === "object" && value !== null) {
            // Valida se os subcampos existem na definição
            for (const [code, subfieldValue] of Object.entries(value)) {
                const subfieldDef = dataField.subFieldDef.find((sf) => sf.code === code)
                if (subfieldDef && typeof subfieldValue === "string") {
                    subfields[code] = subfieldValue
                }
            }
        }

        // Se não há subcampos válidos, coloca no 'a'
        if (Object.keys(subfields).length === 0) {
            subfields.a = String(value)
        }

        return subfields
    }

    /**
     * Busca um registro por ID
     */
    async getRecord(id: string) {
        try {
            return await prisma.catalogRecord.findUnique({
                where: { id },
                include: {
                    fields: {
                        orderBy: { tag: "asc" },
                    },
                },
            })
        } catch (error) {
            console.error("Erro ao buscar registro:", error)
            throw new Error("Falha ao buscar registro")
        }
    }

    /**
     * Lista registros com paginação
     */
    async listRecords(page = 1, limit = 20) {
        try {
            const skip = (page - 1) * limit

            const [records, total] = await Promise.all([
                prisma.catalogRecord.findMany({
                    skip,
                    take: limit,
                    orderBy: { createdAt: "desc" },
                    include: {
                        fields: {
                            select: {
                                tag: true,
                                value: true,
                                fieldType: true,
                            },
                        },
                    },
                }),
                prisma.catalogRecord.count(),
            ])

            return {
                records,
                total,
                pages: Math.ceil(total / limit),
                currentPage: page,
            }
        } catch (error) {
            console.error("Erro ao listar registros:", error)
            throw new Error("Falha ao listar registros")
        }
    }

    /**
     * Atualiza um registro existente
     */
    async updateRecord(id: string, filledFields: Record<string, any>, template: Template) {
        try {
            // Remove campos existentes
            await prisma.catalogField.deleteMany({
                where: { recordId: id },
            })

            // Adiciona novos campos
            const fieldsToCreate = this.prepareFields(filledFields, template)

            await prisma.catalogRecord.update({
                where: { id },
                data: {
                    updatedAt: new Date(),
                    fields: {
                        create: fieldsToCreate,
                    },
                },
            })

            return id
        } catch (error) {
            console.error("Erro ao atualizar registro:", error)
            throw new Error("Falha ao atualizar registro")
        }
    }

    /**
     * Remove um registro
     */
    async deleteRecord(id: string) {
        try {
            await prisma.catalogRecord.delete({
                where: { id },
            })
        } catch (error) {
            console.error("Erro ao remover registro:", error)
            throw new Error("Falha ao remover registro")
        }
    }

    /**
     * Busca registros por template
     */
    async getRecordsByTemplate(templateId: string) {
        try {
            return await prisma.catalogRecord.findMany({
                where: { recordTemplateId: templateId },
                include: {
                    fields: true,
                },
                orderBy: { createdAt: "desc" },
            })
        } catch (error) {
            console.error("Erro ao buscar registros por template:", error)
            throw new Error("Falha ao buscar registros por template")
        }
    }

    /**
     * Estatísticas da base de dados
     */
    async getStats() {
        try {
            const [totalRecords, recordsByTemplate, recentRecords] = await Promise.all([
                prisma.catalogRecord.count(),
                prisma.catalogRecord.groupBy({
                    by: ["templateName"],
                    _count: {
                        id: true,
                    },
                    orderBy: {
                        _count: {
                            id: "desc",
                        },
                    },
                }),
                prisma.catalogRecord.count({
                    where: {
                        createdAt: {
                            gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // últimas 24h
                        },
                    },
                }),
            ])

            return {
                totalRecords,
                recordsByTemplate,
                recentRecords,
            }
        } catch (error) {
            console.error("Erro ao buscar estatísticas:", error)
            throw new Error("Falha ao buscar estatísticas")
        }
    }
}

export const databaseService = new DatabaseService()
