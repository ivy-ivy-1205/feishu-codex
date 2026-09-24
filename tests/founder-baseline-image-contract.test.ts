import{readFileSync}from'node:fs';import{expect,it}from'vitest';
it('builds a fail-closed founder-baseline-only image',()=>{const file=readFileSync(new URL('../Dockerfile.founder-baseline',import.meta.url),'utf8');
  expect(file).toContain('USER node');expect(file).toContain('ENTRYPOINT ["node", "dist/cli/apply-founder-baseline.js"]');
  expect(file).toContain('ai.aijia.image-purpose="founder-work-map-v2-baseline"');
  expect(file).not.toContain('CMD [');expect(file).not.toContain('EXPOSE');expect(file).not.toContain('@openai/codex');expect(file).not.toContain('dist/server.js');
});
