// The access card, drawn the way Blast Radius (Anthropic, Apache-2.0) draws its hold.
import type { Elements } from 'claude-code'

export type Decision = 'permitir' | 'cancelar' | 'sempre' | 'tempo' | 'interrompido' | 'erro'

export type Card = {
  tool: string
  what: string
  folder: string
  root: string | null
  title: string
  decision: Decision | null
  where: 'pane' | 'band'
}

export const CARD_ROWS = 9

export function drawCard(ui: Elements['terminal'] | Elements['desktop'], card: Card) {
  const { Box, Text, Button } = ui as Elements['terminal']
  // The buttons answer the card they were drawn for, never whichever one is held now.
  const decide = (d: Decision) => () => {
    if (card.decision === null) card.decision = d
  }
  const line = (label: string, value: string, dim = false) => (
    <Box key={label} flexDirection="row">
      <Text dimColor>{label.padEnd(11)}</Text>
      <Box flexShrink={1}>
        <Text bold={!dim} dimColor={dim} wrap="truncate-middle">
          {value}
        </Text>
      </Box>
    </Box>
  )
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text bold color="yellow">
        Repo externo · o Claude quer escrever fora da sessão
      </Text>
      {line('Pasta', card.folder)}
      {card.root === null ? line('Raiz', 'resolvendo a raiz…', true) : line('Raiz', `${card.root}  (${card.title})`)}
      {line(card.tool, card.what)}
      {card.root === null ? (
        <Text dimColor>esperando o git dizer se é um repo</Text>
      ) : (
        <Box key="buttons" flexDirection="row" marginTop={1} gap={2}>
          <Button key="permitir" label="Permitir" hotkey="1" variant="primary" autoFocus onPress={decide('permitir')} />
          <Button key="cancelar" label="Cancelar" hotkey="2" onPress={decide('cancelar')} />
          <Button key="sempre" label="Não pedir de novo para este repo" hotkey="3" onPress={decide('sempre')} />
        </Box>
      )}
    </Box>
  )
}
