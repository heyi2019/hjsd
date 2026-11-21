import { createContext, useContext } from "react";

export type AccountImageField = "secondary_images" | "wallet_realname_images" | "account_images";
export type ImageOriginalLoader = (field: AccountImageField, index: number) => Promise<string>;
export const ImageOriginalContext = createContext<ImageOriginalLoader | null>(null);
export const useImageOriginalLoader = () => useContext(ImageOriginalContext);
