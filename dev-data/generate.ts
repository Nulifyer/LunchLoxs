/**
 * Generate test recipe ZIPs for import.
 * Run: bun run dev-data/generate.ts
 */
import JSZip from "jszip";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

interface Recipe {
  title: string;
  tags: string[];
  servings: number;
  prepMinutes: number;
  cookMinutes: number;
  ingredients: Array<{ qty: string; unit: string; item: string }>;
  instructions: string;
  notes?: string;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function ingredientTable(ings: Recipe["ingredients"]): string {
  const qw = Math.max(3, ...ings.map((i) => i.qty.length));
  const uw = Math.max(4, ...ings.map((i) => i.unit.length));
  const iw = Math.max(10, ...ings.map((i) => i.item.length));
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - s.length));
  const h = `| ${pad("Qty", qw)} | ${pad("Unit", uw)} | ${pad("Ingredient", iw)} |`;
  const sep = `| ${"-".repeat(qw)} | ${"-".repeat(uw)} | ${"-".repeat(iw)} |`;
  const rows = ings.map((i) => `| ${pad(i.qty, qw)} | ${pad(i.unit, uw)} | ${pad(i.item, iw)} |`);
  return [h, sep, ...rows].join("\n");
}

function toMarkdown(r: Recipe): string {
  const now = new Date().toISOString();
  const lines = [
    "---",
    `title: "${r.title}"`,
    `tags: [${r.tags.map((t) => `"${t}"`).join(", ")}]`,
    `servings: ${r.servings}`,
    `prepMinutes: ${r.prepMinutes}`,
    `cookMinutes: ${r.cookMinutes}`,
    `createdAt: ${now}`,
    `updatedAt: ${now}`,
    "---",
    "",
    "## Ingredients",
    "",
    ingredientTable(r.ingredients),
    "",
    "## Instructions",
    "",
    r.instructions,
    "",
  ];
  if (r.notes) lines.push("## Notes", "", r.notes, "");
  return lines.join("\n");
}

async function generateBook(name: string, recipes: Recipe[], outDir: string) {
  const zip = new JSZip();
  const folder = zip.folder(name)!;
  folder.file("_book.yaml", [
    `name: "${name}"`,
    `exportedAt: "${new Date().toISOString()}"`,
    `format: "recipepwa-v1"`,
    `recipeCount: ${recipes.length}`,
  ].join("\n"));
  for (const r of recipes) {
    folder.file(`${slugify(r.title)}.md`, toMarkdown(r));
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const path = join(outDir, `${slugify(name)}.zip`);
  writeFileSync(path, buf);
  console.log(`  ${path} (${recipes.length} recipes)`);
}

// ========================================
// Book 1: Italian Classics
// ========================================
const italian: Recipe[] = [
  {
    title: "Spaghetti Carbonara",
    tags: ["italian", "pasta", "quick"],
    servings: 4, prepMinutes: 10, cookMinutes: 15,
    ingredients: [
      { qty: "400", unit: "g", item: "spaghetti" },
      { qty: "200", unit: "g", item: "guanciale or pancetta" },
      { qty: "4", unit: "", item: "large egg yolks" },
      { qty: "2", unit: "", item: "whole eggs" },
      { qty: "100", unit: "g", item: "pecorino romano, finely grated" },
      { qty: "", unit: "", item: "freshly cracked black pepper" },
    ],
    instructions: `Bring a large pot of salted water to a rolling boil. Cook spaghetti until al dente.

Meanwhile, cut guanciale into small strips. Cook in a cold pan over medium heat until the fat renders and the meat is crispy, about 8 minutes.

In a bowl, whisk egg yolks, whole eggs, and most of the pecorino. Add generous black pepper.

When pasta is ready, reserve 1 cup pasta water. Drain and add to the guanciale pan (heat OFF). Toss to coat.

Pour the egg mixture over the pasta, tossing vigorously. Add splashes of pasta water to create a creamy sauce. The residual heat cooks the eggs without scrambling.

Serve immediately with remaining pecorino and more pepper.`,
    notes: "Never add cream. The creaminess comes from the egg and cheese emulsion. Use the best pecorino you can find.",
  },
  {
    title: "Margherita Pizza",
    tags: ["italian", "pizza", "baking"],
    servings: 2, prepMinutes: 120, cookMinutes: 12,
    ingredients: [
      { qty: "500", unit: "g", item: "tipo 00 flour" },
      { qty: "325", unit: "ml", item: "warm water" },
      { qty: "10", unit: "g", item: "salt" },
      { qty: "3", unit: "g", item: "active dry yeast" },
      { qty: "400", unit: "g", item: "San Marzano tomatoes, crushed" },
      { qty: "250", unit: "g", item: "fresh mozzarella" },
      { qty: "1", unit: "bunch", item: "fresh basil" },
      { qty: "2", unit: "tbsp", item: "extra virgin olive oil" },
    ],
    instructions: `Dissolve yeast in warm water, let sit 5 minutes. Mix flour and salt, add water gradually. Knead 10 minutes until smooth and elastic. Cover and rise 1-2 hours.

Preheat oven to the highest setting (250C/500F) with a baking stone or inverted baking sheet.

Divide dough in two. Stretch each ball into a thin round by hand -- don't use a rolling pin.

Spread crushed tomatoes lightly. Tear mozzarella over top. Drizzle with olive oil.

Bake 10-12 minutes until the crust is charred in spots and the cheese is bubbling.

Add fresh basil leaves after removing from oven.`,
  },
  {
    title: "Risotto ai Funghi",
    tags: ["italian", "rice", "comfort food"],
    servings: 4, prepMinutes: 15, cookMinutes: 30,
    ingredients: [
      { qty: "320", unit: "g", item: "arborio or carnaroli rice" },
      { qty: "300", unit: "g", item: "mixed mushrooms, sliced" },
      { qty: "1", unit: "L", item: "warm vegetable or chicken stock" },
      { qty: "1", unit: "", item: "small onion, finely diced" },
      { qty: "2", unit: "cloves", item: "garlic, minced" },
      { qty: "120", unit: "ml", item: "dry white wine" },
      { qty: "50", unit: "g", item: "butter" },
      { qty: "60", unit: "g", item: "parmesan, grated" },
      { qty: "2", unit: "tbsp", item: "olive oil" },
      { qty: "", unit: "", item: "fresh thyme and parsley" },
    ],
    instructions: `Saute mushrooms in olive oil over high heat until golden. Season and set aside.

In the same pan, melt half the butter. Cook onion until translucent, about 5 minutes. Add garlic for 30 seconds.

Add rice and toast for 2 minutes, stirring constantly. Deglaze with wine and stir until absorbed.

Add warm stock one ladle at a time, stirring frequently. Wait until each addition is mostly absorbed before adding the next. This takes about 18-20 minutes.

When rice is creamy but still has a slight bite, remove from heat. Stir in remaining butter, parmesan, and the reserved mushrooms.

Cover and rest 2 minutes. Serve garnished with herbs.`,
  },
  {
    title: "Tiramisu",
    tags: ["italian", "dessert", "no-bake"],
    servings: 8, prepMinutes: 30, cookMinutes: 0,
    ingredients: [
      { qty: "6", unit: "", item: "egg yolks" },
      { qty: "150", unit: "g", item: "sugar" },
      { qty: "500", unit: "g", item: "mascarpone cheese" },
      { qty: "300", unit: "ml", item: "strong espresso, cooled" },
      { qty: "3", unit: "tbsp", item: "coffee liqueur (optional)" },
      { qty: "300", unit: "g", item: "savoiardi (ladyfinger biscuits)" },
      { qty: "2", unit: "tbsp", item: "unsweetened cocoa powder" },
    ],
    instructions: `Whisk egg yolks and sugar until thick and pale, about 5 minutes with an electric mixer.

Fold in mascarpone gently until smooth. Do not overmix.

Combine cooled espresso and liqueur in a shallow dish.

Quickly dip each ladyfinger in the coffee (don't soak -- just a brief dip on each side).

Layer dipped ladyfingers in a 9x13 dish. Spread half the mascarpone cream. Repeat layers.

Cover and refrigerate at least 4 hours, ideally overnight.

Dust generously with cocoa powder before serving.`,
    notes: "The longer it rests, the better the flavors meld. Can be made 2 days ahead.",
  },
  {
    title: "Bruschetta al Pomodoro",
    tags: ["italian", "appetizer", "quick"],
    servings: 6, prepMinutes: 15, cookMinutes: 5,
    ingredients: [
      { qty: "6", unit: "", item: "ripe roma tomatoes, diced" },
      { qty: "1", unit: "clove", item: "garlic, minced" },
      { qty: "1", unit: "handful", item: "fresh basil, torn" },
      { qty: "3", unit: "tbsp", item: "extra virgin olive oil" },
      { qty: "1", unit: "tbsp", item: "balsamic vinegar" },
      { qty: "1", unit: "", item: "baguette or ciabatta, sliced" },
      { qty: "", unit: "", item: "salt and pepper to taste" },
    ],
    instructions: `Combine diced tomatoes, garlic, basil, olive oil, and balsamic. Season with salt and pepper. Let sit 10 minutes.

Toast bread slices under the broiler or on a grill until golden, about 2 minutes per side.

Rub each toast with a cut garlic clove (optional).

Spoon tomato mixture onto toasts. Drizzle with extra olive oil. Serve immediately.`,
  },
];

// ========================================
// Book 2: Asian Favorites
// ========================================
const asian: Recipe[] = [
  {
    title: "Pad Thai",
    tags: ["thai", "noodles", "quick"],
    servings: 2, prepMinutes: 20, cookMinutes: 10,
    ingredients: [
      { qty: "200", unit: "g", item: "flat rice noodles" },
      { qty: "200", unit: "g", item: "shrimp or chicken, sliced" },
      { qty: "2", unit: "", item: "eggs" },
      { qty: "3", unit: "tbsp", item: "fish sauce" },
      { qty: "2", unit: "tbsp", item: "tamarind paste" },
      { qty: "1", unit: "tbsp", item: "palm sugar or brown sugar" },
      { qty: "2", unit: "cloves", item: "garlic, minced" },
      { qty: "1", unit: "cup", item: "bean sprouts" },
      { qty: "3", unit: "", item: "green onions, cut in 2-inch pieces" },
      { qty: "1/4", unit: "cup", item: "roasted peanuts, crushed" },
      { qty: "1", unit: "", item: "lime, cut into wedges" },
    ],
    instructions: `Soak rice noodles in warm water for 30 minutes until pliable. Drain.

Mix fish sauce, tamarind paste, and sugar in a small bowl.

Heat oil in a wok over high heat. Cook protein until done, set aside.

Add garlic, cook 15 seconds. Push aside, crack eggs into the wok and scramble.

Add noodles and sauce mixture. Toss with tongs for 2 minutes.

Return protein. Add bean sprouts and green onions. Toss 30 seconds.

Serve with crushed peanuts and lime wedges.`,
  },
  {
    title: "Japanese Chicken Katsu Curry",
    tags: ["japanese", "curry", "comfort food"],
    servings: 4, prepMinutes: 20, cookMinutes: 40,
    ingredients: [
      { qty: "4", unit: "", item: "boneless chicken thighs" },
      { qty: "1", unit: "cup", item: "panko breadcrumbs" },
      { qty: "1/2", unit: "cup", item: "all-purpose flour" },
      { qty: "2", unit: "", item: "eggs, beaten" },
      { qty: "1", unit: "", item: "onion, diced" },
      { qty: "2", unit: "", item: "carrots, cubed" },
      { qty: "2", unit: "", item: "potatoes, cubed" },
      { qty: "2", unit: "blocks", item: "Japanese curry roux (Golden Curry or similar)" },
      { qty: "600", unit: "ml", item: "water" },
      { qty: "", unit: "", item: "steamed rice for serving" },
      { qty: "", unit: "", item: "oil for frying" },
    ],
    instructions: `For the curry: saute onion until soft. Add carrots and potatoes, cook 3 minutes. Add water, bring to a boil. Simmer 15 minutes until vegetables are tender.

Turn off heat, add curry roux blocks. Stir until dissolved. Simmer on low 5 more minutes until thick.

For the katsu: pound chicken to even thickness. Season with salt and pepper. Dredge in flour, dip in egg, coat in panko.

Shallow fry in 1cm of oil at 170C/340F for 4-5 minutes per side until golden and cooked through. Drain on a wire rack.

Slice katsu. Serve over rice with curry sauce ladled alongside.`,
  },
  {
    title: "Vegetable Stir-Fry with Tofu",
    tags: ["chinese", "vegetarian", "quick", "healthy"],
    servings: 3, prepMinutes: 15, cookMinutes: 10,
    ingredients: [
      { qty: "400", unit: "g", item: "firm tofu, cubed and pressed" },
      { qty: "1", unit: "", item: "red bell pepper, sliced" },
      { qty: "1", unit: "", item: "broccoli crown, cut into florets" },
      { qty: "2", unit: "", item: "baby bok choy, halved" },
      { qty: "3", unit: "tbsp", item: "soy sauce" },
      { qty: "1", unit: "tbsp", item: "sesame oil" },
      { qty: "1", unit: "tbsp", item: "rice vinegar" },
      { qty: "1", unit: "tsp", item: "cornstarch" },
      { qty: "1", unit: "tsp", item: "chili flakes" },
      { qty: "2", unit: "cloves", item: "garlic, sliced" },
      { qty: "1", unit: "inch", item: "ginger, grated" },
    ],
    instructions: `Press tofu for 15 minutes. Cut into cubes.

Mix soy sauce, sesame oil, rice vinegar, and cornstarch for the sauce.

Heat oil in a wok over high heat. Fry tofu until golden on all sides, about 5 minutes. Remove.

Add garlic and ginger, cook 30 seconds. Add broccoli and bell pepper, stir-fry 3 minutes.

Add bok choy and sauce. Toss 1 minute.

Return tofu, add chili flakes. Toss to coat.

Serve over steamed rice or noodles.`,
  },
  {
    title: "Miso Ramen",
    tags: ["japanese", "soup", "noodles", "comfort food"],
    servings: 2, prepMinutes: 15, cookMinutes: 20,
    ingredients: [
      { qty: "2", unit: "portions", item: "fresh ramen noodles" },
      { qty: "3", unit: "tbsp", item: "white miso paste" },
      { qty: "1", unit: "tbsp", item: "sesame paste or tahini" },
      { qty: "800", unit: "ml", item: "chicken or pork stock" },
      { qty: "1", unit: "tbsp", item: "soy sauce" },
      { qty: "2", unit: "", item: "soft-boiled eggs, halved" },
      { qty: "100", unit: "g", item: "chashu pork or sliced pork belly" },
      { qty: "2", unit: "", item: "green onions, sliced" },
      { qty: "", unit: "", item: "nori sheets, corn, bean sprouts for topping" },
    ],
    instructions: `Bring stock to a simmer. Whisk in miso paste and sesame paste until smooth. Add soy sauce. Keep warm but do not boil (boiling destroys miso flavor).

Cook ramen noodles according to package (usually 2-3 minutes). Drain.

If using pork belly, sear slices in a hot pan until caramelized.

Divide noodles between bowls. Ladle hot broth over noodles.

Top with halved soft-boiled egg, pork, green onions, nori, corn, and bean sprouts.`,
    notes: "For the soft-boiled eggs: boil 6.5 minutes, then ice bath. Marinate in soy sauce and mirin overnight for ajitama.",
  },
  {
    title: "Thai Green Curry",
    tags: ["thai", "curry", "spicy"],
    servings: 4, prepMinutes: 15, cookMinutes: 20,
    ingredients: [
      { qty: "400", unit: "ml", item: "coconut milk" },
      { qty: "3", unit: "tbsp", item: "green curry paste" },
      { qty: "500", unit: "g", item: "chicken thigh, sliced" },
      { qty: "1", unit: "", item: "Thai eggplant or regular eggplant, cubed" },
      { qty: "1", unit: "handful", item: "Thai basil leaves" },
      { qty: "2", unit: "tbsp", item: "fish sauce" },
      { qty: "1", unit: "tbsp", item: "palm sugar" },
      { qty: "4", unit: "", item: "kaffir lime leaves" },
      { qty: "1", unit: "", item: "red chili, sliced" },
    ],
    instructions: `Heat a splash of coconut cream (the thick part from the top of the can) in a wok. Fry curry paste for 2 minutes until fragrant.

Add chicken and cook until sealed on all sides.

Pour in remaining coconut milk, fish sauce, and palm sugar. Add kaffir lime leaves.

Bring to a gentle simmer. Add eggplant. Cook 10-15 minutes until chicken is cooked through and eggplant is tender.

Stir in Thai basil. Garnish with sliced chili.

Serve with jasmine rice.`,
  },
];

// ========================================
// Book 3: Baking & Desserts
// ========================================
const baking: Recipe[] = [
  {
    title: "Chocolate Chip Cookies",
    tags: ["baking", "cookies", "dessert"],
    servings: 24, prepMinutes: 15, cookMinutes: 12,
    ingredients: [
      { qty: "2 1/4", unit: "cups", item: "all-purpose flour" },
      { qty: "1", unit: "tsp", item: "baking soda" },
      { qty: "1", unit: "tsp", item: "salt" },
      { qty: "1", unit: "cup", item: "butter, softened" },
      { qty: "3/4", unit: "cup", item: "granulated sugar" },
      { qty: "3/4", unit: "cup", item: "packed brown sugar" },
      { qty: "2", unit: "", item: "large eggs" },
      { qty: "2", unit: "tsp", item: "vanilla extract" },
      { qty: "2", unit: "cups", item: "chocolate chips" },
    ],
    instructions: `Preheat oven to 375F (190C).

Whisk flour, baking soda, and salt in a bowl.

Beat butter and both sugars until light and fluffy, about 3 minutes. Add eggs one at a time, then vanilla.

Gradually mix in flour mixture on low speed. Fold in chocolate chips.

Drop rounded tablespoons onto ungreased baking sheets, spacing 2 inches apart.

Bake 9-11 minutes until edges are golden but centers look slightly underdone.

Cool on baking sheet 5 minutes, then transfer to a wire rack.`,
    notes: "For extra flavor, refrigerate the dough overnight. Brown the butter for a nutty depth.",
  },
  {
    title: "Banana Bread",
    tags: ["baking", "bread", "breakfast"],
    servings: 10, prepMinutes: 15, cookMinutes: 60,
    ingredients: [
      { qty: "3", unit: "", item: "very ripe bananas, mashed" },
      { qty: "1/3", unit: "cup", item: "melted butter" },
      { qty: "3/4", unit: "cup", item: "sugar" },
      { qty: "1", unit: "", item: "egg, beaten" },
      { qty: "1", unit: "tsp", item: "vanilla extract" },
      { qty: "1", unit: "tsp", item: "baking soda" },
      { qty: "1/4", unit: "tsp", item: "salt" },
      { qty: "1 1/2", unit: "cups", item: "all-purpose flour" },
      { qty: "1/2", unit: "cup", item: "walnuts, chopped (optional)" },
    ],
    instructions: `Preheat oven to 350F (175C). Grease a 9x5 inch loaf pan.

Mash bananas in a large bowl. Stir in melted butter.

Mix in sugar, egg, and vanilla. Add baking soda and salt. Fold in flour until just combined. Add walnuts if using.

Pour into prepared pan.

Bake 55-65 minutes until a toothpick comes out clean.

Cool in pan 10 minutes, then turn out onto a wire rack.`,
  },
  {
    title: "Classic French Crepes",
    tags: ["french", "breakfast", "dessert"],
    servings: 8, prepMinutes: 35, cookMinutes: 20,
    ingredients: [
      { qty: "1", unit: "cup", item: "all-purpose flour" },
      { qty: "2", unit: "", item: "eggs" },
      { qty: "1/2", unit: "cup", item: "milk" },
      { qty: "1/2", unit: "cup", item: "water" },
      { qty: "1/4", unit: "tsp", item: "salt" },
      { qty: "2", unit: "tbsp", item: "melted butter" },
    ],
    instructions: `Blend flour, eggs, milk, water, salt, and butter until smooth. Refrigerate batter 30 minutes.

Heat a lightly buttered crepe pan or non-stick skillet over medium-high heat.

Pour approximately 1/4 cup batter, tilting the pan to spread evenly into a thin circle.

Cook about 2 minutes until the bottom is light brown. Flip and cook 1 more minute.

Fill with Nutella and bananas, lemon and sugar, ham and cheese, or your choice.`,
  },
  {
    title: "Lemon Bars",
    tags: ["baking", "dessert", "citrus"],
    servings: 16, prepMinutes: 15, cookMinutes: 40,
    ingredients: [
      { qty: "1", unit: "cup", item: "butter, softened" },
      { qty: "1/2", unit: "cup", item: "powdered sugar, plus more for dusting" },
      { qty: "2", unit: "cups", item: "all-purpose flour" },
      { qty: "4", unit: "", item: "large eggs" },
      { qty: "1 1/2", unit: "cups", item: "granulated sugar" },
      { qty: "1/3", unit: "cup", item: "fresh lemon juice" },
      { qty: "2", unit: "tbsp", item: "lemon zest" },
      { qty: "1/4", unit: "cup", item: "all-purpose flour (for filling)" },
    ],
    instructions: `Preheat oven to 350F (175C). Line a 9x13 pan with parchment.

For the crust: mix butter, powdered sugar, and 2 cups flour until crumbly. Press into pan. Bake 15-20 minutes until lightly golden.

For the filling: whisk eggs, sugar, lemon juice, zest, and 1/4 cup flour.

Pour filling over hot crust.

Bake 20-25 minutes until filling is set and edges are lightly browned.

Cool completely. Dust with powdered sugar. Cut into bars.`,
  },
  {
    title: "Cinnamon Rolls",
    tags: ["baking", "breakfast", "comfort food"],
    servings: 12, prepMinutes: 120, cookMinutes: 25,
    ingredients: [
      { qty: "4", unit: "cups", item: "all-purpose flour" },
      { qty: "1/3", unit: "cup", item: "sugar" },
      { qty: "1", unit: "tsp", item: "salt" },
      { qty: "2 1/4", unit: "tsp", item: "instant yeast" },
      { qty: "1", unit: "cup", item: "warm milk" },
      { qty: "1/3", unit: "cup", item: "butter, melted" },
      { qty: "2", unit: "", item: "eggs" },
      { qty: "1", unit: "cup", item: "brown sugar (filling)" },
      { qty: "2 1/2", unit: "tbsp", item: "cinnamon (filling)" },
      { qty: "1/3", unit: "cup", item: "softened butter (filling)" },
      { qty: "4", unit: "oz", item: "cream cheese (glaze)" },
      { qty: "1", unit: "cup", item: "powdered sugar (glaze)" },
      { qty: "1", unit: "tsp", item: "vanilla (glaze)" },
    ],
    instructions: `Mix flour, sugar, salt, and yeast. Add warm milk, melted butter, and eggs. Knead 8 minutes until smooth. Rise 1 hour.

Roll dough into a large rectangle, about 16x12 inches. Spread softened butter over surface. Sprinkle brown sugar and cinnamon evenly.

Roll up tightly from the long side. Cut into 12 equal pieces.

Place in a greased 9x13 pan. Cover and rise 30 minutes.

Bake at 350F (175C) for 22-25 minutes until golden.

For glaze: beat cream cheese, powdered sugar, and vanilla until smooth. Spread over warm rolls.`,
    notes: "For overnight rolls: after cutting and placing in pan, cover and refrigerate overnight. Let come to room temperature 30 minutes before baking.",
  },
];

async function generateMultiBook(filename: string, bookList: Array<{ name: string; recipes: Recipe[] }>, outDir: string) {
  const zip = new JSZip();
  for (const { name, recipes } of bookList) {
    const folder = zip.folder(name)!;
    folder.file("_book.yaml", [
      `name: "${name}"`,
      `exportedAt: "${new Date().toISOString()}"`,
      `format: "recipepwa-v1"`,
      `recipeCount: ${recipes.length}`,
    ].join("\n"));
    for (const r of recipes) {
      folder.file(`${slugify(r.title)}.md`, toMarkdown(r));
    }
  }
  const buf = await zip.generateAsync({ type: "nodebuffer" });
  const path = join(outDir, filename);
  writeFileSync(path, buf);
  const total = bookList.reduce((sum, b) => sum + b.recipes.length, 0);
  console.log(`  ${path} (${bookList.length} books, ${total} recipes)`);
}

async function main() {
  const outDir = join(import.meta.dir);
  console.log("Generating test data ZIPs...");
  await generateBook("Italian Classics", italian, outDir);
  await generateBook("Asian Favorites", asian, outDir);
  await generateBook("Baking & Desserts", baking, outDir);
  await generateMultiBook("all-books.zip", [
    { name: "Italian Classics", recipes: italian },
    { name: "Asian Favorites", recipes: asian },
    { name: "Baking & Desserts", recipes: baking },
  ], outDir);
  console.log("Done! Import these ZIPs via Manage Books > Import.");
}

main();
