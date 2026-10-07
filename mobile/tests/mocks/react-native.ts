export const Platform = {
  OS: "ios",
  select: (obj: any) => obj.ios ?? obj.default,
};

export const PermissionsAndroid = {
  PERMISSIONS: {
    ACCESS_FINE_LOCATION: "android.permission.ACCESS_FINE_LOCATION",
    READ_CONTACTS: "android.permission.READ_CONTACTS",
  },
  RESULTS: {
    GRANTED: "granted",
    DENIED: "denied",
    NEVER_ASK_AGAIN: "never_ask_again",
  },
  check: async (_perm: string) => false,
  request: async (_perm: string, _rationale?: any) => "denied",
};

export const Share = {
  sharedAction: "sharedAction",
  dismissedAction: "dismissedAction",
  share: async (_content: any, _options?: any) => ({
    action: "sharedAction",
  }),
};

export const StyleSheet = {
  create: (styles: any) => styles,
};

export const View = "View";
export const Text = "Text";
export const TouchableOpacity = "TouchableOpacity";
export const TextInput = "TextInput";
export const ScrollView = "ScrollView";
export const Switch = "Switch";
export const Modal = "Modal";
export const SafeAreaView = "SafeAreaView";
export const ActivityIndicator = "ActivityIndicator";
export const Alert = {
  alert: (_title: string, _message?: string, _buttons?: any[]) => {},
};

export default {
  Platform,
  PermissionsAndroid,
  Share,
  StyleSheet,
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  Switch,
  Modal,
  SafeAreaView,
  ActivityIndicator,
  Alert,
};
