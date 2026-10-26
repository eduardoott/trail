# Trail

Mod do Claude Code: uma aba de árvore de arquivos para cada repo git em que o Claude mexe, o da sessão e os de fora (WSL incluído). A aba do repo onde ele lê, edita ou roda comando vem para a frente sozinha, e cada arquivo tocado acende na árvore: roxo para leitura, laranja para edição, verde para arquivo novo.

## O que ele faz

- Uma aba por repo git. A primeira edição do Claude num repo abre a aba dele.
- A aba segue o Claude: quem está sendo editado vem para a frente.
- Rastro: o que o Claude leu e editou fica aceso na árvore, com contadores de linhas.
- Replay: os botões no topo da aba repassam o último turno, comando a comando.
- Botão `±` mostra só os arquivos alterados; botão `Σ` troca a coluna da direita entre data e tamanho.
- Modo cartão: em vez de abrir sozinha, um cartão pede permissão na primeira escrita num repo de fora.

## Instalar

Pelo marketplace deste repositório:

```bash
claude plugin marketplace add eduardoott/trail
claude plugin install trail@trail
```

Ou adicione a pasta à suite do seu time e instale a partir dela.

No terminal, a aba pede o layout fullscreen (`/tui fullscreen`) e pelo menos 110 colunas. No app desktop a aba abre na lateral.

## Comandos

```
/trail abrir <pasta>      abre a aba de um repo
/trail fechar <raiz>      fecha a aba daquele repo
/trail esquecer <raiz>    esquece a permissão dada no cartão (ou `tudo`)
```

## Ajustes

Em `/config`, seção do plugin:

| Ajuste | Padrão | O que faz |
|---|---|---|
| Aba segue o Claude | on | a aba do repo em uso vem para a frente sozinha |
| Aba do repo da sessão | on | abre a aba do repo da sessão ao iniciar |
| Leitura também | sim | a aba abre também quando o Claude só lê |
| Ícones | auto | Nerd Font quando houver, Unicode no app desktop |
| Coluna da direita | date | data da última modificação ou tamanho |
| Linha de diagnóstico | off | escreve na conversa cada troca de aba |
| Animação do replay | moderno | clássico acende cada comando por 2 s |
| Animação ao vivo | animado | a versão curta da animação a cada leitura ou edição |
| Como a aba abre | sozinha | ou cartão, que pede permissão antes |

## Testes

```bash
claude plugin validate .
claude plugin test .
```

## Créditos

A árvore nasce do filetree 0.2.24 (Kurt Buhler, MIT) e o cartão de permissão segue o Blast Radius (Anthropic, Apache-2.0). Detalhe em [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md). Licença MIT em [LICENSE](LICENSE).
