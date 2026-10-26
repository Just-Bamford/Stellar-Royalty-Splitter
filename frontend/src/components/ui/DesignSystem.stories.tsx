import type { Meta, StoryObj } from "@storybook/react";
import { Alert, Badge, Button, Card, Field, Stack } from "./DesignSystem";

const meta = { title: "Design System/Primitives", component: Card, parameters: { layout: "centered" } } satisfies Meta<typeof Card>;
export default meta;
type Story = StoryObj<typeof meta>;

export const CardsAndStatus: Story = { render: () => <Stack gap="md"><Card tone="interactive"><Stack gap="sm"><h2>Royalty distribution</h2><Badge tone="success">Healthy</Badge><Alert tone="info">All payouts are ready for review.</Alert><Button>Review distribution</Button></Stack></Card></Stack> };
export const Controls: Story = { render: () => <Stack gap="md"><Field label="Contract address" placeholder="G..." hint="Use a valid Stellar address" /><Stack gap="sm"><Button size="sm">Small</Button><Button variant="secondary">Secondary</Button><Button variant="ghost">Ghost</Button><Button variant="danger">Danger</Button></Stack></Stack> };
export const StatusVariants: Story = { render: () => <Stack gap="sm"><Badge>Neutral</Badge><Badge tone="success">Success</Badge><Badge tone="warning">Warning</Badge><Badge tone="danger">Danger</Badge><Badge tone="info">Info</Badge></Stack> };
