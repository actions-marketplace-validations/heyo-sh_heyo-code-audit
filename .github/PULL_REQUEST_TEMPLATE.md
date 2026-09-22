## Summary

Describe the user-visible, operational, or security effect and link the issue
it resolves.

## Validation

- [ ] `bun run lint`
- [ ] `bun run typecheck`
- [ ] `bun run test:coverage`
- [ ] `bun run build`
- [ ] I regenerated and committed `dist/action.js` when the Action bundle changed.
- [ ] I added or updated tests for behaviour changes.
- [ ] I updated `README.md`, `action.yml`, and examples where the Action contract changed.

## Compatibility and release

- [ ] This is backwards compatible.
- [ ] This intentionally changes or removes documented behaviour and is clearly described above.
- [ ] I added a Changeset for a consumer-visible Action change.
