// The access card, drawn the way Blast Radius (Anthropic, Apache-2.0) draws its hold.
import type { Elements } from 'claude-code'

export type Decision = 'allow' | 'cancel' | 'always' | 'timeout' | 'interrupted' | 'error'

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
        External repo · Claude wants to write outside the session
      </Text>
      {line('Folder', card.folder)}
      {card.root === null ? line('Root', 'resolving the root…', true) : line('Root', `${card.root}  (${card.title})`)}
      {line(card.tool, card.what)}
      {card.root === null ? (
        <Text dimColor>waiting for git to say whether it is a repo</Text>
      ) : (
        <Box key="buttons" flexDirection="row" marginTop={1} gap={2}>
          <Button key="allow" label="Allow" hotkey="1" variant="primary" autoFocus onPress={decide('allow')} />
          <Button key="cancel" label="Cancel" hotkey="2" onPress={decide('cancel')} />
          <Button key="always" label="Don't ask again for this repo" hotkey="3" onPress={decide('always')} />
        </Box>
      )}
    </Box>
  )
}
