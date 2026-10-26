import type { Preview } from "@storybook/react";
import "../src/modern-styles.css";
import "../src/index.css";
import "../src/components/ui/design-system.css";

const preview: Preview = {
  globalTypes: {
    theme: {
      description: "Theme",
      defaultValue: "light",
      toolbar: { icon: "paintbrush", items: ["light", "dark"] },
    },
  },
  decorators: [(Story, context) => <div data-theme={context.globals.theme}><Story /></div>],
};
export default preview;
