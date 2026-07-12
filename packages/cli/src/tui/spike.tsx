import React from "react";
import { Box, Text, Static, useInput } from "ink";

export function Spike({ committed, live, onKey }: { committed: string[]; live: string; onKey?: (s: string) => void }) {
  useInput((input) => { onKey?.(input); }, { isActive: !!onKey });
  return (
    <Box flexDirection="column">
      <Static items={committed}>{(item, i) => <Text key={i}>{item}</Text>}</Static>
      <Box><Text>{live}</Text></Box>
    </Box>
  );
}
