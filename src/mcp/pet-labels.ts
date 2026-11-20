import type { OwnerT, OwnerText } from "../i18n/index.js";
import type { PetMood, PetStage } from "./pet-store.js";

/** The pet's stage, for /pet and the pet's notices. */
export function petStageLabel(t: OwnerT<"commands">, stage: PetStage): OwnerText {
  switch (stage) {
    case "egg": return t("pet.stage.egg");
    case "baby": return t("pet.stage.baby");
    case "child": return t("pet.stage.child");
    case "teen": return t("pet.stage.teen");
    case "adult": return t("pet.stage.adult");
    case "elder": return t("pet.stage.elder");
  }
}

/** The pet's mood word (PetStore.computeMood), for /pet. */
export function petMoodLabel(t: OwnerT<"commands">, mood: PetMood): OwnerText {
  switch (mood) {
    case "sleeping": return t("pet.mood.sleeping");
    case "recovering": return t("pet.mood.recovering");
    case "sick": return t("pet.mood.sick");
    case "hungry": return t("pet.mood.hungry");
    case "blissful": return t("pet.mood.blissful");
    case "happy": return t("pet.mood.happy");
    case "content": return t("pet.mood.content");
    case "bored": return t("pet.mood.bored");
    case "sad": return t("pet.mood.sad");
    case "miserable": return t("pet.mood.miserable");
  }
}
