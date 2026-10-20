/** All model-bearing and prewarm threads must bypass global memory machinery. */
export const NATIVE_MEMORY_OFF = {
  features: { memories: false },
  memories: { use_memories: false, generate_memories: false },
};
