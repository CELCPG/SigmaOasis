/**
 * Recipes (v4.0, C3 — an experiment, off by default).
 *
 * A recipe is a method for a task, not a turn: what a skill's `playbook.md`
 * is to a chat, its `agent.md` is to an agent task. The host matches the
 * task's first words against triggers (the same matcher skills use in a
 * chat) and hands the engine the recipe; the engine puts its text in the
 * system prompt after the project's instructions, and the report says which
 * recipe was followed. Four ship with the app — the ones the front door
 * offers — and a user's skill with an `agent.md` joins them.
 *
 * Pure: matching and text. The skill folders are the host's.
 */
import { selectSkill } from '../../shared/skills'

export interface Recipe {
  id: string
  name: string
  triggers: string[]
  /** The method, as the model is handed it. */
  text: string
}

export const MAX_RECIPE_CHARS = 6_000

export const SHIPPED_RECIPES: readonly Recipe[] = [
  {
    id: 'tidy-folder',
    name: 'Tidy a folder',
    triggers: ['tidy', 'tidy up', 'organize', 'organise', 'sort the files', 'clean up the folder', 'declutter'],
    text: [
      '1. List the folder first (list_directory, then glob for sub-folders). Do not move anything until you can say, in one line, what is there: how many files, which kinds, which are obviously misplaced.',
      '2. Propose the layout before making it: a few folders named by kind or by year, not one per file. If the user gave a layout, use theirs exactly.',
      '3. Move with move_file, one file per call, never copy: a tidy folder has one of each. Make each destination folder with make_directory first.',
      '4. Never delete, rename or open a file the task did not mention; a duplicate is deleted only when the task asks and the two files are byte-identical (read both).',
      '5. Report the layout you made and how many files went where; name any file you left alone and why.'
    ].join('\n')
  },
  {
    id: 'summarize-here',
    name: 'Summarize what is here',
    triggers: ['summarize what is here', 'summarise what is here', 'what is in this folder', 'summarize this folder', 'summarize these', 'give me an overview of'],
    text: [
      '1. Map the folder: list_directory at the top, glob for the kinds present (documents, spreadsheets, code, images), and the sizes.',
      '2. Read what can be read — read_document for .docx, .xlsx, .pptx, .pdf, .csv and .md; read_file for code and text — biggest and newest first, and stop reading once the picture is clear. Do not read binary files.',
      '3. Write the summary in the report, not in a file, unless the task asks for a file: what the folder is for, its main documents in one line each, and anything that looks out of place or unfinished.',
      '4. Say what you did not read and why (too many, too large, unreadable).'
    ].join('\n')
  },
  {
    id: 'fill-template',
    name: 'Fill a template from data',
    triggers: ['fill the template', 'fill a template', 'from the template', 'mail merge', 'one letter per', 'one document per', 'generate the letters'],
    text: [
      '1. Read the template (read_document or read_file) and list its placeholders — {name}, [DATE], <<field>>, whatever it uses — before reading the data.',
      '2. Read the data (read_document for .csv or .xlsx). Match each placeholder to a column by name; if one has no column, ask (ask_user when offered) rather than guess.',
      '3. Make one output per row with write_document (.docx or .txt from the filled text), named as the task says, or by the row’s name column when it does not.',
      '4. Leave the template and the data untouched. Report how many documents you made and name one so the user can check it.'
    ].join('\n')
  },
  {
    id: 'fix-failing-test',
    name: 'Fix the failing test',
    triggers: ['fix the failing test', 'fix the failing tests', 'make the tests pass', 'tests are failing', 'test is failing', 'fix the test'],
    text: [
      '1. Run the tests first (run_command) and read the failure — the test name, the assertion, the file and line — before opening any source file.',
      '2. Read the failing test, then the code it exercises. Decide whether the code or the test is wrong: the task says fix the code unless the test is plainly mistaken; say so if it is.',
      '3. Make the smallest edit that makes the test pass without breaking the others (edit_file). Do not add skips, loosen assertions or delete tests.',
      '4. Run the whole suite again. Report the command, its exit code and the change; if something still fails, say which and why.'
    ].join('\n')
  }
]

/** The recipe a task calls for, from the shipped four and the host's, in that order; null when none matches. */
export function selectRecipe(prompt: string, extra: readonly Recipe[] = []): Recipe | null {
  const hit = selectSkill(prompt, [...SHIPPED_RECIPES, ...extra])
  return hit ? hit.skill : null
}

/** A skill's `agent.md` as a recipe, when it has one. */
export function recipeFromSkill(skill: { id: string; name: string; triggers: string[]; agentText?: string }): Recipe | null {
  const text = skill.agentText?.trim()
  return text ? { id: skill.id, name: skill.name, triggers: skill.triggers, text: text.slice(0, MAX_RECIPE_CHARS) } : null
}
