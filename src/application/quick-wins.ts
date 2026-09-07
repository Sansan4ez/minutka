import { z } from "zod";

export const quickWinIds = [
  "report_template",
  "data_import_export",
  "async_status",
  "checklist",
  "routing_rule",
  "waiting_sla",
  "batching",
  "mail_extraction",
  "priority_rule",
  "document_dispatch",
  "api_integration",
  "document_base",
  "ai_research",
  "ai_assistant_calc",
  "extraction_sorting",
  "technical_spec_review",
  "contract_template",
  "ai_image_generation",
  "bulk_mailing",
] as const;

export type QuickWinId = (typeof quickWinIds)[number];
export type QuickWinEffort = "hours" | "days" | "weeks";
export type QuickWinOwner = "employee" | "internal_it" | "with_algoritm";

export type QuickWin = {
  id: QuickWinId;
  typicalFor: string;
  title: string;
  whatChanges: string;
  effort: QuickWinEffort;
  whoCanDo: QuickWinOwner;
  humanInTheLoop: string;
  firstStep: string;
};

export const quickWinCatalog: readonly QuickWin[] = [
  {
    id: "report_template",
    typicalFor: "подготовка отчётов и ручная отчётность",
    title: "Шаблон отчёта с формулами и AI-черновиком текста",
    whatChanges: "Таблица сама собирает показатели и готовит черновик пояснений по данным",
    effort: "days",
    whoCanDo: "employee",
    humanInTheLoop: "Сотрудник проверяет цифры, контекст и финальный текст перед отправкой",
    firstStep: "Собрать один повторяющийся отчёт и отметить его источники и формулы",
  },
  {
    id: "data_import_export",
    typicalFor: "любой ручной перенос между системами, таблицами и CRM",
    title: "Импорт и экспорт вместо ручного переноса",
    whatChanges: "Данные переносятся через форму, импорт или экспорт, а не перепечатываются вручную",
    effort: "days",
    whoCanDo: "internal_it",
    humanInTheLoop: "Сотрудник проверяет сопоставление полей и исправляет исключения",
    firstStep: "Выписать поля, которые переносятся вручную между системами, таблицами и CRM",
  },
  {
    id: "async_status",
    typicalFor: "регулярные статусы и встречи ради обновления прогресса",
    title: "Письменный статус вместо встречи",
    whatChanges: "Обновление прогресса собирается в коротком письменном статусе или статус-боте",
    effort: "hours",
    whoCanDo: "employee",
    humanInTheLoop: "Команда сама отмечает блокеры и решает, что требует отдельного обсуждения",
    firstStep: "Договориться о формате письменного статуса и времени его публикации",
  },
  {
    id: "checklist",
    typicalFor: "повторяющиеся операции с несколькими шагами",
    title: "Чек-лист повторяющейся операции",
    whatChanges: "Обязательные шаги и результат операции фиксируются в одном шаблоне",
    effort: "hours",
    whoCanDo: "employee",
    humanInTheLoop: "Сотрудник выполняет шаги, проверяет результат и отмечает отклонения",
    firstStep: "Записать последнюю повторяющуюся операцию по шагам и отметить обязательные пункты",
  },
  {
    id: "routing_rule",
    typicalFor: "распределение входящих задач и координация между сотрудниками",
    title: "Одна точка входа и правило маршрутизации",
    whatChanges: "Новая задача попадает в одну точку и автоматически направляется ответственному",
    effort: "days",
    whoCanDo: "internal_it",
    humanInTheLoop: "Ответственный подтверждает маршрут и берёт в работу нестандартные случаи",
    firstStep: "Собрать типы входящих задач и назначить для каждого простое правило маршрутизации",
  },
  {
    id: "waiting_sla",
    typicalFor: "ожидание ответа или входных данных",
    title: "Напоминание по сроку ответа",
    whatChanges: "Запрос получает дату ожидания и автоматическое напоминание или эскалацию",
    effort: "hours",
    whoCanDo: "employee",
    humanInTheLoop: "Сотрудник решает, когда эскалировать и как продолжить после ответа",
    firstStep: "Договориться о сроке ответа на уточнение",
  },
  {
    id: "batching",
    typicalFor: "частое переключение между однотипными задачами",
    title: "Пакетирование однотипных задач",
    whatChanges: "Одинаковые задачи выполняются блоками в заранее выбранные окна без прерываний",
    effort: "hours",
    whoCanDo: "employee",
    humanInTheLoop: "Сотрудник выбирает окна, меняет приоритеты и прерывает пакет при срочном случае",
    firstStep: "Найти один тип задач, который можно собрать в ежедневное или еженедельное окно",
  },
  {
    id: "mail_extraction",
    typicalFor: "перенос реквизитов из писем в таблицы и системы",
    title: "Извлечение реквизитов из писем с проверкой",
    whatChanges: "AI-ассистент извлекает поля из письма и предлагает заполненную запись",
    effort: "days",
    whoCanDo: "with_algoritm",
    humanInTheLoop: "Сотрудник проверяет извлечённые реквизиты и исправляет сомнительные поля",
    firstStep: "Собрать несколько типичных писем и список реквизитов, которые из них переносятся",
  },
  {
    id: "priority_rule",
    typicalFor: "неясные приоритеты и конкурирующие задачи",
    title: "Явное правило приоритета на неделю",
    whatChanges: "Задачи сортируются по заранее согласованному правилу вместо постоянного выбора вручную",
    effort: "hours",
    whoCanDo: "employee",
    humanInTheLoop: "Сотрудник пересматривает правило при изменении целей и срочных обстоятельств",
    firstStep: "Выбрать одно правило, по которому команда будет расставлять приоритеты на следующую неделю",
  },
  {
    id: "document_dispatch",
    typicalFor: "отправка пакетов документов контрагентам",
    title: "Сборка и отправка пакета документов из одной точки",
    whatChanges: "Шаблон собирает пакет и сопроводительное письмо, а отправка проходит из одного места",
    effort: "days",
    whoCanDo: "internal_it",
    humanInTheLoop: "Сотрудник проверяет состав пакета, адресата и отправку",
    firstStep: "Составить список документов и проверок для одного типового пакета",
  },
  {
    id: "api_integration",
    typicalFor: "ручной обмен с внешним сервисом: СБИС, банк или маркетплейс",
    title: "Заявки попадают в CRM без ручного переноса",
    whatChanges: "Форма или коннектор создаёт карточку заявки; менеджер проверяет и дополняет, а не перепечатывает",
    effort: "weeks",
    whoCanDo: "internal_it",
    humanInTheLoop: "Менеджер подтверждает карточку и разбирает исключения",
    firstStep: "Собрать список полей, которые переносятся вручную из заявки в CRM",
  },
  {
    id: "document_base",
    typicalFor: "поиск и повторное использование документов и шаблонов",
    title: "Единая база документов с поиском и версиями",
    whatChanges: "Актуальные документы и шаблоны находятся в одном месте с понятной версией",
    effort: "days",
    whoCanDo: "internal_it",
    humanInTheLoop: "Ответственный поддерживает актуальность, права доступа и статус документа",
    firstStep: "Собрать часто используемые документы и выбрать единое место для их хранения",
  },
  {
    id: "ai_research",
    typicalFor: "поиск информации, отбор тендеров и изучение договоров",
    title: "AI-исследование с источниками и проверкой человеком",
    whatChanges: "Ассистент собирает релевантные материалы и кратко связывает выводы с источниками",
    effort: "days",
    whoCanDo: "with_algoritm",
    humanInTheLoop: "Специалист проверяет источники, выводы и решение по результату поиска",
    firstStep: "Определить один тип исследования и шаблон результата с обязательными источниками",
  },
  {
    id: "ai_assistant_calc",
    typicalFor: "расчёты и подготовка материалов по шаблону",
    title: "AI-ассистент расчётов по шаблону",
    whatChanges: "Ассистент готовит черновик расчёта и материалов по заданному шаблону",
    effort: "days",
    whoCanDo: "with_algoritm",
    humanInTheLoop: "Специалист проверяет исходные данные, формулы и итоговый результат",
    firstStep: "Выбрать типовой расчёт и описать его входные данные, формулы и проверки",
  },
  {
    id: "extraction_sorting",
    typicalFor: "разбор входящего потока заявок, писем и документов",
    title: "Извлечение полей и сортировка входящего потока",
    whatChanges: "Из входящих материалов извлекаются поля и выбирается маршрут, а исключения остаются на ручной проверке",
    effort: "weeks",
    whoCanDo: "with_algoritm",
    humanInTheLoop: "Сотрудник проверяет исключения и исправляет неверную классификацию",
    firstStep: "Собрать типы входящих материалов и определить поля и маршруты для каждого",
  },
  {
    id: "technical_spec_review",
    typicalFor: "разбор технических заданий и требований",
    title: "AI-выжимка требований по шаблону",
    whatChanges: "Ассистент выделяет требования, ограничения и вопросы из технического задания",
    effort: "days",
    whoCanDo: "with_algoritm",
    humanInTheLoop: "Специалист сверяет выжимку с исходным заданием и подтверждает требования",
    firstStep: "Составить шаблон выжимки с разделами требований, ограничений и открытых вопросов",
  },
  {
    id: "contract_template",
    typicalFor: "оформление договоров по типовым условиям",
    title: "Шаблон договора с подстановкой реквизитов",
    whatChanges: "Типовой договор заполняется из проверенных реквизитов вместо ручного копирования",
    effort: "days",
    whoCanDo: "internal_it",
    humanInTheLoop: "Специалист проверяет условия, реквизиты и финальную версию перед подписанием",
    firstStep: "Выбрать один типовой договор и отметить постоянные и переменные поля",
  },
  {
    id: "ai_image_generation",
    typicalFor: "подготовка изображений для коммерческих предложений и рассылок",
    title: "Генерация изображений по брифу",
    whatChanges: "Ассистент создаёт варианты изображения по брифу вместо ручной подготовки каждого варианта",
    effort: "hours",
    whoCanDo: "with_algoritm",
    humanInTheLoop: "Сотрудник выбирает подходящий вариант и проверяет соответствие брифу и бренду",
    firstStep: "Подготовить бриф с форматом, содержанием и примерами для одного типа изображения",
  },
  {
    id: "bulk_mailing",
    typicalFor: "однотипные письма многим адресатам",
    title: "Массовая рассылка по шаблону",
    whatChanges: "Письма формируются по шаблону с персонализацией вместо ручной отправки каждого письма",
    effort: "days",
    whoCanDo: "internal_it",
    humanInTheLoop: "Сотрудник проверяет текст, список адресатов и тестовое письмо перед отправкой",
    firstStep: "Собрать шаблон письма и проверить список адресатов на одном небольшом сегменте",
  },
] as const satisfies readonly QuickWin[];

export const quickWinIdSchema = z.enum(quickWinIds);
export const quickWinAssignmentSchema = z.union([quickWinIdSchema, z.literal("deep_dive")]);

export function findQuickWin(id: string): QuickWin | undefined {
  return quickWinCatalog.find((quickWin) => quickWin.id === id);
}
